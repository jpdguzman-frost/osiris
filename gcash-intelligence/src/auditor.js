import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs-extra';
import path from 'path';
import { Analyzer } from './analyzer.js';
import { Store } from './store.js';
import {
  logInfo, logSuccess, logWarn, logError, logDim,
  CostTracker, ensureDirs, PATHS,
} from './utils.js';

const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 8192;

// ─── Auditor Class ────────────────────────────────────────────────────────────

export class Auditor {
  constructor() {
    this.client = new Anthropic();
    this.store = new Store();
    this.costTracker = new CostTracker();
  }

  async run() {
    const gcashScreensDir = path.join(PATHS.screens, 'gcash_current');
    const gcashAnalysisDir = path.join(PATHS.analysis, 'gcash_current');

    if (!await fs.pathExists(gcashScreensDir)) {
      logWarn('No gcash_current screens found. Place GCash screenshots in:');
      logWarn(`  ${gcashScreensDir}`);
      logWarn('Then re-run: node scripts/audit.js');
      return null;
    }

    const files = (await fs.readdir(gcashScreensDir))
      .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f));

    if (files.length === 0) {
      logWarn('gcash_current directory is empty');
      return null;
    }

    logInfo(`Found ${files.length} GCash current screens`);

    // Step 1: Analyze individual screens (uses Analyzer in audit mode)
    await ensureDirs(gcashAnalysisDir);
    const analyzer = new Analyzer();
    const analyzeResult = await analyzer.analyzeIndustry('gcash_current');
    logSuccess(`Individual analysis: ${analyzeResult.analyzed} new, ${analyzeResult.skipped} existing`);

    // Step 2: Ingest to MongoDB
    await this.store.connect();
    await this.store.ingestAnalysis(['gcash_current']);

    // Step 3: Load cross-industry synthesis
    const synthesisPath = path.join(PATHS.synthesis, 'cross_industry_synthesis.json');
    let crossIndustry = null;
    if (await fs.pathExists(synthesisPath)) {
      crossIndustry = await fs.readJson(synthesisPath);
    } else {
      logWarn('No cross-industry synthesis found. Run synthesize.js first for best results.');
    }

    // Step 4: Holistic audit pass
    logInfo('Running holistic GCash audit');
    const gcashData = await this.store.exportForSynthesis('gcash_current');

    const audit = await this.runHolisticAudit(gcashData, crossIndustry);

    // Save audit
    await ensureDirs(PATHS.synthesis);
    await fs.writeJson(
      path.join(PATHS.synthesis, 'gcash_audit.json'),
      audit,
      { spaces: 2 },
    );

    // Store in MongoDB
    await this.store.db.collection('synthesis').updateOne(
      { type: 'gcash_audit' },
      { $set: { type: 'gcash_audit', created_at: new Date(), data: audit } },
      { upsert: true },
    );

    this.costTracker.print();
    await this.store.close();

    logSuccess('GCash audit complete');
    return audit;
  }

  async runHolisticAudit(gcashData, crossIndustry) {
    const prompt = `You are auditing GCash's current visual design for a major redesign pitch. GCash is the Philippines' leading fintech super-app serving 94 million users.

Target redesign direction: CALM & CONFIDENT + BOLD & FORWARD.

## Current GCash Screen Analyses:
${JSON.stringify(gcashData.map(s => ({
  screen_id: s.screen_id,
  scores: s.scores,
  verdict: s.analysis?.verdict,
  dated_elements: s.analysis?.dated_elements,
  missed_opportunities: s.analysis?.missed_opportunities,
  strengths_to_preserve: s.analysis?.strengths_to_preserve,
  color: s.analysis?.color_analysis,
  typography: s.analysis?.typography_analysis,
  spatial: s.analysis?.spatial_analysis,
})), null, 2)}

${crossIndustry ? `## Cross-Industry Synthesis (what best-in-class looks like):
${JSON.stringify({
  top_principles: crossIndustry.top_10_principles,
  tension_resolution: crossIndustry.tension_resolution,
  fintech_opportunity: crossIndustry.fintech_opportunity,
}, null, 2)}` : ''}

Produce a comprehensive audit:

1. **Overall assessment**: Where does GCash stand today? Be specific with scores and comparisons.
2. **Critical gaps**: The top 5 most impactful visual design gaps vs best-in-class (from any industry).
3. **Dated elements inventory**: All visual elements that need updating, prioritized.
4. **Strengths to preserve**: What GCash does well that competitors don't — the DNA to keep.
5. **Quick wins**: Changes that would have outsized visual impact with minimal risk.
6. **Deep changes**: Fundamental design system shifts needed.
7. **Screen-by-screen priorities**: For each key screen type, the top redesign priority.
8. **Competitive positioning**: How GCash compares to Revolut, Nubank, Grab, Maya, etc.

Output as JSON:
{
  "overall_assessment": { "summary": "", "avg_quality_score": 0, "industry_percentile": "", "biggest_strength": "", "biggest_weakness": "" },
  "critical_gaps": [{ "gap": "", "severity": "critical|high|medium", "industry_benchmark": "", "impact": "" }],
  "dated_elements": [{ "element": "", "severity": "critical|moderate|minor", "modern_alternative": "" }],
  "strengths_to_preserve": [{ "strength": "", "rationale": "" }],
  "quick_wins": [{ "change": "", "impact": "high|medium", "risk": "low|medium", "effort": "small|medium" }],
  "deep_changes": [{ "change": "", "rationale": "", "reference_industry": "" }],
  "screen_priorities": { "home_dashboard": "", "send_money": "", "transaction_history": "", "wallet_balance": "", "qr_payment": "" },
  "competitive_positioning": { "vs_revolut": "", "vs_nubank": "", "vs_grab": "", "vs_maya": "" }
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
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      return JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch {
      logError('Failed to parse audit response');
      return { raw: text };
    }
  }
}
