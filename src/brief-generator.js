import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs-extra';
import path from 'path';
import { Store } from './store.js';
import {
  logInfo, logSuccess, logError, logDim,
  CostTracker, ensureDirs, PATHS, CLAUDE_MODEL, parseJsonResponse,
} from './utils.js';

const MODEL = CLAUDE_MODEL;
const MAX_TOKENS = 8192;

// ─── Brief Generator Class ───────────────────────────────────────────────────

export class BriefGenerator {
  constructor() {
    this.client = new Anthropic();
    this.store = new Store();
    this.costTracker = new CostTracker();
  }

  async run() {
    await this.store.connect();
    await ensureDirs(path.join(PATHS.data, 'briefs'), PATHS.outputBriefs);

    // Load inputs
    const synthesisPath = path.join(PATHS.synthesis, 'cross_industry_synthesis.json');
    const auditPath = path.join(PATHS.synthesis, 'gcash_audit.json');

    const crossIndustry = await fs.pathExists(synthesisPath)
      ? await fs.readJson(synthesisPath)
      : null;

    const audit = await fs.pathExists(auditPath)
      ? await fs.readJson(auditPath)
      : null;

    if (!crossIndustry) {
      logError('No cross-industry synthesis found. Run synthesize.js first.');
      return null;
    }

    // Load dimension syntheses
    const dimensions = {};
    for (const dim of ['color', 'typography', 'spatial', 'hierarchy', 'identity', 'emotion']) {
      const dimPath = path.join(PATHS.synthesis, `dimension_${dim}.json`);
      if (await fs.pathExists(dimPath)) {
        dimensions[dim] = await fs.readJson(dimPath);
      }
    }

    // Get top reference screens for each brief
    const topCalm = await this.store.queryTopScreens('calm_confident', 8, 20);
    const topBold = await this.store.queryTopScreens('bold_forward', 8, 20);
    const crossTarget = await this.store.queryCrossTarget(7, 7, 20);

    logInfo('Generating 3 visual direction briefs');

    // Generate all 3 briefs
    const briefs = await this.generateBriefs({
      crossIndustry,
      audit,
      dimensions,
      topCalm: topCalm.map(s => ({ id: s.screen_id, industry: s.industry, scores: s.scores, verdict: s.analysis?.verdict })),
      topBold: topBold.map(s => ({ id: s.screen_id, industry: s.industry, scores: s.scores, verdict: s.analysis?.verdict })),
      crossTarget: crossTarget.map(s => ({ id: s.screen_id, industry: s.industry, scores: s.scores, verdict: s.analysis?.verdict })),
    });

    // Save briefs
    for (let i = 0; i < briefs.length; i++) {
      const num = i + 1;

      // JSON data
      await fs.writeJson(
        path.join(PATHS.data, 'briefs', `direction_${num}.json`),
        briefs[i],
        { spaces: 2 },
      );

      // Formatted markdown
      const md = this.formatBriefMarkdown(briefs[i], num);
      await fs.writeFile(
        path.join(PATHS.outputBriefs, `direction_${num}.md`),
        md,
      );

      logSuccess(`Direction ${num}: "${briefs[i].title}" saved`);
    }

    // Store in MongoDB
    for (let i = 0; i < briefs.length; i++) {
      await this.store.db.collection('synthesis').updateOne(
        { type: `visual_direction_${i + 1}` },
        { $set: { type: `visual_direction_${i + 1}`, created_at: new Date(), data: briefs[i] } },
        { upsert: true },
      );
    }

    this.costTracker.print();
    await this.store.close();

    logSuccess('All 3 visual direction briefs generated');
    return briefs;
  }

  async generateBriefs(inputs) {
    const prompt = `You are the creative director for a redesign of GCash — the Philippines' #1 fintech super-app (94M users). You're generating 3 DISTINCT visual direction briefs for a C-suite pitch.

CONTEXT:
- Current design is ~5 years old
- Target launch: October 2026
- Emotional territory: CALM & CONFIDENT + BOLD & FORWARD
- This is for Frost Design, a 38-person Filipino agency competing against international agencies
- The pitch must be visionary yet achievable

## Cross-Industry Intelligence:
${JSON.stringify(inputs.crossIndustry, null, 2)}

${inputs.audit ? `## Current GCash Audit:
${JSON.stringify(inputs.audit, null, 2)}` : ''}

## Dimension Recommendations:
${Object.entries(inputs.dimensions).map(([dim, data]) =>
  `### ${dim}: ${JSON.stringify(data.recommendations?.slice(0, 3))}`
).join('\n')}

## Reference Screens (highest scorers):
Top Calm+Confident: ${JSON.stringify(inputs.topCalm.slice(0, 10))}
Top Bold+Forward: ${JSON.stringify(inputs.topBold.slice(0, 10))}
Sweet Spot (both high): ${JSON.stringify(inputs.crossTarget.slice(0, 10))}

---

Generate exactly 3 OPINIONATED visual direction briefs. They must be:
1. **DISTINCT** — not safe middle grounds, but strong theses that each take a different stance
2. **SPECIFIC** — concrete enough for a designer (or AI) to create screens from them
3. **GROUNDED** — rooted in the industry analysis, not generic design theory

Each brief must include concrete specifications for these 5 key GCash screens:
- Home Dashboard
- Send Money
- Transaction History
- Wallet/Balance
- QR Payment

Direction 1 should lean MORE calm/confident (luxury/health inspired).
Direction 2 should lean MORE bold/forward (aerospace/automotive inspired).
Direction 3 should be the opinionated synthesis — the one you'd actually pitch.

Output as JSON array of 3 briefs:
[
  {
    "direction_number": 1,
    "title": "Short, evocative title (2-4 words)",
    "thesis": "One-paragraph creative thesis — the big idea",
    "emotional_target": {
      "calm_confident_weight": 0.0-1.0,
      "bold_forward_weight": 0.0-1.0,
      "primary_mood": "description",
      "spectrum_targets": {
        "calm_energetic": [-5,+5],
        "confident_tentative": [-5,+5],
        "forward_conservative": [-5,+5],
        "premium_accessible": [-5,+5],
        "warm_clinical": [-5,+5]
      }
    },
    "source_industries": ["primary influence", "secondary influence"],
    "core_principles": [
      { "principle": "", "source_industry": "", "implementation": "how this manifests in GCash" }
    ],
    "color_direction": {
      "primary_palette": { "background": "#hex", "surface": "#hex", "text_primary": "#hex", "text_secondary": "#hex" },
      "accent_system": { "primary_accent": "#hex", "secondary_accent": "#hex", "success": "#hex", "warning": "#hex", "error": "#hex" },
      "dark_mode": true/false,
      "gradient_approach": "description",
      "color_philosophy": "description"
    },
    "typography_direction": {
      "heading_font_style": "description (weight, case, tracking, suggested typeface or category)",
      "body_font_style": "description",
      "type_scale": "tight | moderate | generous | dramatic",
      "key_treatments": ["description of distinctive type treatments"],
      "hierarchy_approach": "description"
    },
    "spatial_direction": {
      "density": "minimal | balanced | information_rich",
      "whitespace_approach": "description",
      "layout_system": "description (grid, spacing unit, key patterns)",
      "card_style": "description (radius, shadow, border, surface treatment)",
      "key_spatial_technique": "the signature spatial move"
    },
    "motion_direction": {
      "overall_feel": "description",
      "transition_style": "description",
      "micro_interactions": "description",
      "signature_animation": "description of one distinctive animation"
    },
    "screen_specs": {
      "home_dashboard": {
        "layout": "detailed layout description",
        "key_elements": ["what appears, in what order"],
        "distinctive_feature": "what makes this home screen unique",
        "color_application": "how color direction applies here",
        "information_hierarchy": "what's primary > secondary > tertiary"
      },
      "send_money": {
        "layout": "",
        "key_elements": [],
        "distinctive_feature": "",
        "flow_approach": "how the send money flow feels",
        "input_treatment": "how amount/recipient inputs are styled"
      },
      "transaction_history": {
        "layout": "",
        "key_elements": [],
        "distinctive_feature": "",
        "data_presentation": "how transaction data is displayed",
        "filtering_approach": "how users find specific transactions"
      },
      "wallet_balance": {
        "layout": "",
        "key_elements": [],
        "distinctive_feature": "",
        "balance_presentation": "how the main balance is displayed",
        "secondary_info": "what else appears on this screen"
      },
      "qr_payment": {
        "layout": "",
        "key_elements": [],
        "distinctive_feature": "",
        "scan_experience": "how the QR scanning feels",
        "confirmation_flow": "how payment confirmation works"
      }
    }
  }
]`;

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
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      return JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch {
      logError('Failed to parse briefs response');
      return [{ raw: text }];
    }
  }

  formatBriefMarkdown(brief, num) {
    return `# Visual Direction ${num}: ${brief.title}

## Thesis
${brief.thesis}

## Emotional Target
- **Calm & Confident Weight**: ${brief.emotional_target?.calm_confident_weight}
- **Bold & Forward Weight**: ${brief.emotional_target?.bold_forward_weight}
- **Primary Mood**: ${brief.emotional_target?.primary_mood}

### Spectrum Targets
${Object.entries(brief.emotional_target?.spectrum_targets || {}).map(([k, v]) =>
  `- **${k}**: ${v}`
).join('\n')}

## Source Industries
${brief.source_industries?.map(s => `- ${s}`).join('\n')}

## Core Principles
${brief.core_principles?.map(p =>
  `### ${p.principle}\n- **Source**: ${p.source_industry}\n- **Implementation**: ${p.implementation}`
).join('\n\n')}

## Color Direction
- **Philosophy**: ${brief.color_direction?.color_philosophy}
- **Dark Mode**: ${brief.color_direction?.dark_mode}
- **Gradients**: ${brief.color_direction?.gradient_approach}

### Primary Palette
${Object.entries(brief.color_direction?.primary_palette || {}).map(([k, v]) =>
  `- ${k}: \`${v}\``
).join('\n')}

### Accent System
${Object.entries(brief.color_direction?.accent_system || {}).map(([k, v]) =>
  `- ${k}: \`${v}\``
).join('\n')}

## Typography Direction
- **Headings**: ${brief.typography_direction?.heading_font_style}
- **Body**: ${brief.typography_direction?.body_font_style}
- **Scale**: ${brief.typography_direction?.type_scale}
- **Hierarchy**: ${brief.typography_direction?.hierarchy_approach}

### Key Treatments
${brief.typography_direction?.key_treatments?.map(t => `- ${t}`).join('\n')}

## Spatial Direction
- **Density**: ${brief.spatial_direction?.density}
- **Whitespace**: ${brief.spatial_direction?.whitespace_approach}
- **Layout**: ${brief.spatial_direction?.layout_system}
- **Cards**: ${brief.spatial_direction?.card_style}
- **Signature Move**: ${brief.spatial_direction?.key_spatial_technique}

## Motion Direction
- **Overall**: ${brief.motion_direction?.overall_feel}
- **Transitions**: ${brief.motion_direction?.transition_style}
- **Micro-interactions**: ${brief.motion_direction?.micro_interactions}
- **Signature Animation**: ${brief.motion_direction?.signature_animation}

## Screen Specifications

### Home Dashboard
${formatScreenSpec(brief.screen_specs?.home_dashboard)}

### Send Money
${formatScreenSpec(brief.screen_specs?.send_money)}

### Transaction History
${formatScreenSpec(brief.screen_specs?.transaction_history)}

### Wallet / Balance
${formatScreenSpec(brief.screen_specs?.wallet_balance)}

### QR Payment
${formatScreenSpec(brief.screen_specs?.qr_payment)}

---
*Generated by GCash Intelligence Pipeline — Phase 1*
`;
  }
}

function formatScreenSpec(spec) {
  if (!spec) return '*No specification provided*';
  return Object.entries(spec)
    .map(([key, val]) => {
      const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      if (Array.isArray(val)) {
        return `**${label}**:\n${val.map(v => `  - ${v}`).join('\n')}`;
      }
      return `**${label}**: ${val}`;
    })
    .join('\n');
}
