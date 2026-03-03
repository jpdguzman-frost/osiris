import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs-extra';
import path from 'path';
import { Store } from './store.js';
import {
  logInfo, logSuccess, logWarn, logError, logDim,
  CostTracker, ensureDirs, PATHS, CLAUDE_MODEL, parseJsonResponse,
} from './utils.js';

const MODEL = CLAUDE_MODEL;
const MAX_TOKENS = 8192;

// ─── Synthesizer Class ────────────────────────────────────────────────────────

export class Synthesizer {
  constructor() {
    this.client = new Anthropic();
    this.store = new Store();
    this.costTracker = new CostTracker();
  }

  async run() {
    await this.store.connect();
    await ensureDirs(PATHS.synthesis);

    logInfo('Starting cross-industry synthesis');

    // Get all data
    const allScreens = await this.store.exportForSynthesis();
    const stats = await this.store.getStats();
    logInfo(`Working with ${allScreens.length} analyzed screens across ${Object.keys(stats.byIndustry).length} industries`);

    // Run synthesis passes
    const dimensions = ['color', 'typography', 'spatial', 'hierarchy', 'identity', 'emotion'];
    const dimensionResults = {};

    for (const dim of dimensions) {
      logInfo(`  Synthesizing: ${dim}`);
      dimensionResults[dim] = await this.synthesizeDimension(dim, allScreens, stats);
      await fs.writeJson(
        path.join(PATHS.synthesis, `dimension_${dim}.json`),
        dimensionResults[dim],
        { spaces: 2 },
      );
    }

    // Cross-industry pattern synthesis
    logInfo('  Synthesizing: cross-industry patterns');
    const crossIndustry = await this.synthesizeCrossIndustry(allScreens, stats, dimensionResults);
    await fs.writeJson(
      path.join(PATHS.synthesis, 'cross_industry_synthesis.json'),
      crossIndustry,
      { spaces: 2 },
    );

    // Store in MongoDB
    const synthesis = this.store.db.collection('synthesis');
    for (const dim of dimensions) {
      await synthesis.updateOne(
        { type: `dimension_${dim}` },
        { $set: { type: `dimension_${dim}`, created_at: new Date(), data: dimensionResults[dim] } },
        { upsert: true },
      );
    }
    await synthesis.updateOne(
      { type: 'cross_industry' },
      { $set: { type: 'cross_industry', created_at: new Date(), data: crossIndustry } },
      { upsert: true },
    );

    this.costTracker.print();
    await this.store.close();

    logSuccess('Synthesis complete');
    return { dimensionResults, crossIndustry };
  }

  // ── Dimension Synthesis ─────────────────────────────────────────────────

  async synthesizeDimension(dimension, allScreens, stats) {
    // Build a focused data extract for this dimension
    const dimensionMap = {
      color: 'color_analysis',
      typography: 'typography_analysis',
      spatial: 'spatial_analysis',
      hierarchy: 'hierarchy_clarity',
      identity: 'identity_signals',
      emotion: null, // uses scores
    };

    const relevantScores = {
      color: ['color_restraint'],
      typography: ['hierarchy_clarity', 'glanceability'],
      spatial: ['whitespace_ratio', 'density'],
      hierarchy: ['hierarchy_clarity', 'glanceability'],
      identity: ['brand_confidence'],
      emotion: ['calm_confident', 'bold_forward', 'calm_energetic', 'confident_tentative', 'forward_conservative', 'premium_accessible', 'warm_clinical'],
    };

    // Get top screens for this dimension
    const topScreens = allScreens
      .filter(s => s.scores && s.analysis)
      .sort((a, b) => {
        const aScore = relevantScores[dimension].reduce((sum, k) => sum + (Math.abs(a.scores[k]) || 0), 0);
        const bScore = relevantScores[dimension].reduce((sum, k) => sum + (Math.abs(b.scores[k]) || 0), 0);
        return bScore - aScore;
      })
      .slice(0, 80); // Top 80 screens

    // Build data summary (keep under context limits)
    const dataSummary = topScreens.map(s => ({
      screen_id: s.screen_id,
      industry: s.industry,
      scores: Object.fromEntries(
        relevantScores[dimension].map(k => [k, s.scores[k]])
      ),
      verdict: s.analysis?.verdict,
      dimension_data: dimensionMap[dimension] ? s.analysis?.[dimensionMap[dimension]] : null,
      principles: s.analysis?.principles_extracted?.slice(0, 2),
    }));

    const prompt = `You are synthesizing visual design intelligence for a major fintech super-app redesign (GCash, Philippines, 94M users).

Target emotional territories: CALM & CONFIDENT + BOLD & FORWARD.

DIMENSION: ${dimension.toUpperCase()}

Here are the top-scoring screens across 6 industries for the ${dimension} dimension:

${JSON.stringify(dataSummary, null, 2)}

Industry score averages for relevant metrics:
${JSON.stringify(stats.averages, null, 2)}

Synthesize the ${dimension} findings:

1. **Top patterns**: What ${dimension} approaches consistently score highest? Be specific.
2. **Industry leaders**: Which industries excel at ${dimension} and why?
3. **Anti-patterns**: What ${dimension} approaches correlate with low scores?
4. **Fintech gap**: Where do fintech screens underperform vs other industries on ${dimension}?
5. **GCash recommendations**: 5 specific, actionable ${dimension} recommendations for a fintech super-app redesign.

Output as JSON:
{
  "dimension": "${dimension}",
  "top_patterns": [{ "pattern": "", "evidence": "", "industries": [] }],
  "industry_leaders": [{ "industry": "", "why": "" }],
  "anti_patterns": [{ "pattern": "", "consequence": "" }],
  "fintech_gap": { "description": "", "magnitude": "", "opportunity": "" },
  "recommendations": [{ "recommendation": "", "priority": "critical|high|medium", "reference_screens": [] }]
}`;

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    });

    const usage = response.usage || {};
    this.costTracker.addCall({
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
    });

    const text = response.content[0]?.text || '';
    try {
      return parseJsonResponse(text);
    } catch {
      logError(`  Failed to parse ${dimension} synthesis response`);
      return { dimension, raw: text };
    }
  }

  // ── Cross-Industry Synthesis ────────────────────────────────────────────

  async synthesizeCrossIndustry(allScreens, stats, dimensionResults) {
    // Get screens that score high on BOTH emotional territories
    const crossTargetScreens = allScreens
      .filter(s => s.scores && (s.scores.calm_confident || 0) >= 7 && (s.scores.bold_forward || 0) >= 7)
      .sort((a, b) => (b.scores.calm_confident + b.scores.bold_forward) - (a.scores.calm_confident + a.scores.bold_forward))
      .slice(0, 30);

    // Get principles from screen analyses
    const allPrinciples = allScreens
      .flatMap(s => (s.analysis?.principles_extracted || []).map(p => ({ ...p, industry: s.industry })));
    const directPrinciples = allPrinciples.filter(p => p.transferability === 'directly_applicable');
    const adaptablePrinciples = allPrinciples.filter(p => p.transferability === 'adaptable');

    const prompt = `You are the lead design strategist for a major fintech super-app redesign (GCash, Philippines, 94M users).

Target emotional territories:
- CALM & CONFIDENT: Trust through restraint. Clarity through hierarchy. Sophistication through simplicity.
- BOLD & FORWARD: Ambition through craft. Presence through decisiveness. Innovation through intentional surprise.

You've analyzed ${allScreens.length} screens across automotive, luxury, health, aerospace, gaming, and fintech industries.

## Screens scoring high on BOTH emotional territories (the "sweet spot"):
${JSON.stringify(crossTargetScreens.map(s => ({
  screen_id: s.screen_id,
  industry: s.industry,
  calm_confident: s.scores.calm_confident,
  bold_forward: s.scores.bold_forward,
  overall: s.scores.overall_quality,
  verdict: s.analysis?.verdict,
})), null, 2)}

## Dimension synthesis summaries:
${Object.entries(dimensionResults).map(([dim, data]) =>
  `### ${dim}\nRecommendations: ${JSON.stringify(data.recommendations?.slice(0, 3))}`
).join('\n\n')}

## Directly applicable principles (${directPrinciples.length}):
${JSON.stringify(directPrinciples.slice(0, 30).map(p => ({
  industry: p.industry,
  principle: p.principle,
  evidence: p.evidence,
})), null, 2)}

## Stats by industry:
${JSON.stringify(stats.byIndustry)}

Now synthesize:

1. **Recurring patterns** (3+ industries): The design principles that transcend industry
2. **The GCash opportunity**: Where the fintech baseline lags most, creating the biggest redesign opportunity
3. **Top 10 transferable principles**: The most actionable principles for a fintech super-app
4. **Tension resolution**: How to resolve the tension between calm/confident AND bold/forward
5. **Industry fusion map**: Which specific elements to borrow from each industry

Output as JSON:
{
  "recurring_patterns": [{ "pattern": "", "industries": [], "strength": "" }],
  "fintech_opportunity": { "biggest_gaps": [], "competitive_advantage": "" },
  "top_10_principles": [{ "rank": 1, "principle": "", "source_industries": [], "implementation": "" }],
  "tension_resolution": { "thesis": "", "strategies": [] },
  "industry_fusion_map": { "automotive": [], "luxury": [], "health": [], "aerospace": [], "gaming": [] },
  "meta_insight": ""
}`;

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    });

    const usage = response.usage || {};
    this.costTracker.addCall({
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
    });

    const text = response.content[0]?.text || '';
    try {
      return parseJsonResponse(text);
    } catch {
      logError('Failed to parse cross-industry synthesis');
      return { raw: text };
    }
  }
}
