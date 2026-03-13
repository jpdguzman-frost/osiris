// ─── Similarity Engine ────────────────────────────────────────────────────────
// Three-layer fusion search: semantic + visual + score

import { extractBrand } from './utils.js';

// ─── Weight Presets ───────────────────────────────────────────────────────────

export const WEIGHT_PRESETS = {
  default:    { semantic: 0.35, visual: 0.40, score: 0.25 },
  visual:     { semantic: 0.15, visual: 0.65, score: 0.20 },
  conceptual: { semantic: 0.55, visual: 0.20, score: 0.25 },
  quality:    { semantic: 0.20, visual: 0.20, score: 0.60 },
};

// ─── Helper Functions ─────────────────────────────────────────────────────────

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;

  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export function jaccardSimilarity(setA, setB) {
  if (!setA?.length || !setB?.length) return 0;
  const a = new Set(setA);
  const b = new Set(setB);
  const intersection = [...a].filter(x => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

export function l2Normalize(v) {
  if (!v || v.length === 0) return v;
  let mag = 0;
  for (const val of v) mag += val * val;
  mag = Math.sqrt(mag);
  if (mag === 0) return v.map(() => 0);
  return v.map(val => val / mag);
}

// Normalize scores to 0-1 vectors
// Core metrics (1-10): divide by 10
// Emotional spectrum (-5 to +5): (val + 5) / 10
const CORE_FIELDS = [
  'color_restraint', 'hierarchy_clarity', 'glanceability', 'density',
  'whitespace_ratio', 'brand_confidence', 'calm_confident', 'bold_forward',
  'overall_quality',
];
const SPECTRUM_FIELDS = [
  'calm_energetic', 'confident_tentative', 'forward_conservative',
  'premium_accessible', 'warm_clinical',
];

export function scoresToVector(scores) {
  if (!scores) return new Array(14).fill(0);
  const vec = [];
  for (const f of CORE_FIELDS) {
    vec.push((scores[f] || 0) / 10);
  }
  for (const f of SPECTRUM_FIELDS) {
    vec.push(((scores[f] || 0) + 5) / 10);
  }
  return vec;
}

// ─── Layer 1: Semantic Similarity ─────────────────────────────────────────────
// Based on Claude-generated fingerprint data

export function computeSemanticSimilarity(fpA, fpB) {
  if (!fpA || !fpB) return 0;

  // 0.4 × Jaccard on style_tags
  const tagSim = jaccardSimilarity(fpA.style_tags, fpB.style_tags);

  // 0.3 × enum match ratio (layout_type, design_mood, color_temp, typeface_class)
  const enums = ['layout_type', 'design_mood', 'color_temp', 'typeface_class'];
  let enumMatches = 0;
  let enumTotal = 0;
  for (const e of enums) {
    if (fpA[e] && fpB[e]) {
      enumTotal++;
      if (fpA[e] === fpB[e]) enumMatches++;
    }
  }
  const enumSim = enumTotal > 0 ? enumMatches / enumTotal : 0;

  // 0.3 × cosine on boolean flags
  const boolFlags = [
    'has_hero_image', 'has_bottom_nav', 'has_top_bar', 'has_cards',
    'has_icons', 'has_illustrations', 'has_gradient', 'has_shadow',
    'has_dividers', 'has_fab', 'has_avatar',
  ];
  const boolA = boolFlags.map(f => fpA[f] ? 1 : 0);
  const boolB = boolFlags.map(f => fpB[f] ? 1 : 0);
  const boolSim = cosineSimilarity(boolA, boolB);

  return 0.4 * tagSim + 0.3 * enumSim + 0.3 * boolSim;
}

// ─── Layer 2: Visual Similarity ───────────────────────────────────────────────
// Weighted sub-layer approach: compare each feature type independently
// so color histogram (48-dim) doesn't drown out structural features (9-dim).

export function computeVisualSimilarity(vfA, vfB) {
  if (!vfA || !vfB) return 0;

  const colorA = vfA.color_histogram || [];
  const colorB = vfB.color_histogram || [];
  const spatialA = vfA.spatial_color_map || [];
  const spatialB = vfB.spatial_color_map || [];
  const edgeA = vfA.edge_density_map || [];
  const edgeB = vfB.edge_density_map || [];

  if (colorA.length === 0 && spatialA.length === 0 && edgeA.length === 0) return 0;

  // Compare each feature type separately, then weight them.
  // Edge density captures structure (minimal splash vs dense form).
  // Spatial color captures regional color distribution.
  // Color histogram captures overall palette.
  const colorSim = colorA.length > 0 && colorB.length > 0
    ? cosineSimilarity(l2Normalize(colorA), l2Normalize(colorB)) : 0;
  const spatialSim = spatialA.length > 0 && spatialB.length > 0
    ? cosineSimilarity(l2Normalize(spatialA), l2Normalize(spatialB)) : 0;
  const edgeSim = edgeA.length > 0 && edgeB.length > 0
    ? cosineSimilarity(l2Normalize(edgeA), l2Normalize(edgeB)) : 0;

  // Structure gets the most weight so a minimal splash never matches a dense form
  return 0.25 * colorSim + 0.30 * spatialSim + 0.45 * edgeSim;
}

// ─── Layer 3: Score Similarity ────────────────────────────────────────────────
// Based on 14-dim normalized score vector

export function computeScoreSimilarity(scoresA, scoresB) {
  const vecA = scoresToVector(scoresA);
  const vecB = scoresToVector(scoresB);
  return cosineSimilarity(vecA, vecB);
}

// ─── Fusion ───────────────────────────────────────────────────────────────────

export function computeSimilarity(screenA, screenB, weights = WEIGHT_PRESETS.default) {
  const semantic = computeSemanticSimilarity(screenA.fingerprint, screenB.fingerprint);
  const visual = computeVisualSimilarity(screenA.visual_features, screenB.visual_features);
  const score = computeScoreSimilarity(screenA.analysis?.scores, screenB.analysis?.scores);

  const total = weights.semantic * semantic + weights.visual * visual + weights.score * score;

  return {
    total,
    semantic,
    visual,
    score,
    weights,
  };
}

// ─── Find Similar (Brute-force Top-K) ─────────────────────────────────────────

export function findSimilar(target, allScreens, options = {}) {
  const {
    weights = WEIGHT_PRESETS.default,
    top = 10,
    excludeSelf = true,
    maxPerApp = 3, // diversity cap: max N results from the same app/brand
  } = options;

  const results = [];

  for (const screen of allScreens) {
    if (excludeSelf && screen.screen_id === target.screen_id) continue;

    const sim = computeSimilarity(target, screen, weights);
    results.push({
      screen_id: screen.screen_id,
      industry: screen.industry,
      source: screen.source,
      similarity: sim,
    });
  }

  results.sort((a, b) => b.similarity.total - a.similarity.total);

  // Diversity pass: cap results per app/brand so one app doesn't flood
  if (maxPerApp > 0) {
    const appCounts = {};
    const diverse = [];
    for (const r of results) {
      const app = extractBrand(r.screen_id);
      appCounts[app] = (appCounts[app] || 0) + 1;
      if (appCounts[app] <= maxPerApp) {
        diverse.push(r);
        if (diverse.length >= top) break;
      }
    }
    return diverse;
  }

  return results.slice(0, top);
}

// ─── Text Search ──────────────────────────────────────────────────────────────
// Match against tags, enums, and verdict text

const SYNONYMS = {
  minimal: ['clean', 'whitespace_rich', 'borderless'],
  editorial: ['typographic', 'image_forward'],
  dark: ['dark_ui', 'monochrome'],
  light: ['light_ui', 'clean'],
  colorful: ['vibrant', 'gradient_heavy'],
  modern: ['futuristic', 'geometric', 'flat'],
  classic: ['corporate', 'neo_grotesque'],
  fancy: ['luxury', 'premium', 'glassmorphism'],
  simple: ['minimal', 'flat', 'clean'],
  bold: ['angular', 'shadowed', 'dense_info'],
  card: ['card_based', 'modular'],
  illustration: ['illustrative', 'playful'],
};

export function textSearch(query, allScreens, options = {}) {
  const { top = 20 } = options;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  // Expand synonyms
  const expandedTerms = new Set(terms);
  for (const term of terms) {
    if (SYNONYMS[term]) {
      for (const syn of SYNONYMS[term]) expandedTerms.add(syn);
    }
  }

  const results = [];

  for (const screen of allScreens) {
    let score = 0;
    const fp = screen.fingerprint || {};
    const analysis = screen.analysis || {};

    // Match style_tags (strongest signal)
    if (fp.style_tags) {
      for (const tag of fp.style_tags) {
        if (expandedTerms.has(tag)) score += 3;
      }
    }

    // Match enums
    for (const field of ['layout_type', 'design_mood', 'color_temp', 'typeface_class']) {
      if (fp[field] && expandedTerms.has(fp[field])) score += 2;
    }

    // Match screen_type
    if (analysis.screen_type && expandedTerms.has(analysis.screen_type)) score += 2;

    // Match verdict text (weakest signal)
    if (analysis.verdict) {
      const verdict = analysis.verdict.toLowerCase();
      for (const term of expandedTerms) {
        if (verdict.includes(term)) score += 1;
      }
    }

    if (score > 0) {
      results.push({
        screen_id: screen.screen_id,
        industry: screen.industry,
        source: screen.source,
        relevance: score,
        verdict: analysis.verdict,
      });
    }
  }

  results.sort((a, b) => b.relevance - a.relevance);
  return results.slice(0, top);
}
