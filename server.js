import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { Store } from './src/store.js';
import { PATHS, CLAUDE_MODEL, SCORE_FIELDS as SCORE_FIELD_LISTS, brandDisplayName } from './src/utils.js';
import { findSimilar, WEIGHT_PRESETS } from './src/similarity.js';
import { setupAuth } from './src/auth.js';
import { validateSOM, prepareSOM, scaleSOM } from './src/som.js';
import { upgradeToV2, assignRolesTree } from './src/som-roles.js';
import { mergeSOM } from './src/som-merge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, '.env'), override: true });

const PORT = process.env.PORT || 3000;
const BASE_PATH = process.env.BASE_PATH || '';
const app = express();
const router = express.Router();
const store = new Store();

// Helper to build image URLs with base path
const screenUrl = (industry, filePath) => {
  // Derive screen_id from filePath (e.g. "fuse_08.png" → "fuse_08")
  const screenId = filePath ? filePath.replace(/\.[^.]+$/, '') : '';
  return `${BASE_PATH}/api/screens/${screenId}/image`;
};

// Parse comma-separated query param into MongoDB filter value
const parseMultiFilter = (val) => {
  const items = val.split(',');
  return items.length > 1 ? { $in: items } : items[0];
};

// Load config files into memory
const industriesConfig = await fs.readJson(path.join(PATHS.config, 'industries.json'));
const vocabularies = await fs.readJson(path.join(PATHS.config, 'vocabularies.json'));

const SCORE_FIELDS = Object.fromEntries([
  ...SCORE_FIELD_LISTS.core.map(f => [f, [1, 10]]),
  ...SCORE_FIELD_LISTS.spectrum.map(f => [f, [-5, 5]]),
]);

// Connect to MongoDB
await store.connect();

// ─── Middleware ──────────────────────────────────────────────────────────────

app.use(express.json());
app.set('trust proxy', 1);

// ─── Auth ────────────────────────────────────────────────────────────────────

const { requireAuth } = setupAuth(router, BASE_PATH);

// ─── API: Stats ──────────────────────────────────────────────────────────────

router.get('/api/stats', async (req, res) => {
  try {
    const stats = await store.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Industries ─────────────────────────────────────────────────────────

router.get('/api/industries', async (req, res) => {
  try {
    const stats = await store.getStats();
    const industries = industriesConfig.industries.map(i => ({
      id: i.id,
      name: i.name,
      count: stats.byIndustry[i.id] || 0,
    }));
    // Include special industries not in config
    for (const [id, count] of Object.entries(stats.byIndustry)) {
      if (!industries.find(i => i.id === id)) {
        const INDUSTRY_LABELS = { gcash_current: 'GCash App' };
        industries.push({ id, name: INDUSTRY_LABELS[id] || id.replace(/_/g, ' '), count });
      }
    }
    res.json({ industries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Vocabularies ───────────────────────────────────────────────────────

router.get('/api/vocabularies', (req, res) => {
  res.json(vocabularies);
});

// ─── API: Brands ────────────────────────────────────────────────────────────

router.get('/api/brands', async (req, res) => {
  try {
    const filter = {};
    if (req.query.industry) filter.industry = req.query.industry;
    const results = await store.db.collection('screens').aggregate([
      { $match: filter },
      { $group: { _id: { brand: '$brand', industry: '$industry' }, count: { $sum: 1 } } },
      { $sort: { '_id.brand': 1 } }
    ]).toArray();
    const brands = results
      .filter(r => r._id.brand)
      .map(r => ({ slug: r._id.brand, name: brandDisplayName(r._id.brand), industry: r._id.industry, count: r.count }));
    res.json({ brands });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Screens (paginated + filtered) ─────────────────────────────────────

router.get('/api/screens', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 24));
    const sortField = req.query.sort || 'overall_quality';
    const order = req.query.order === 'asc' ? 1 : -1;

    const filter = {};
    if (req.query.industry) filter.industry = req.query.industry;
    if (req.query.brand) filter.brand = parseMultiFilter(req.query.brand);
    if (req.query.screen_type) filter['analysis.screen_type'] = parseMultiFilter(req.query.screen_type);
    if (req.query.mood) filter['fingerprint.design_mood'] = req.query.mood;
    if (req.query.layout) filter['fingerprint.layout_type'] = req.query.layout;
    if (req.query.tags) filter['fingerprint.style_tags'] = { $in: req.query.tags.split(',') };
    if (req.query.q) filter.$text = { $search: req.query.q };
    const scoreKey = `analysis.scores.${sortField}`;
    if (req.query.min_score || req.query.max_score) {
      filter[scoreKey] = {};
      if (req.query.min_score) filter[scoreKey].$gte = parseFloat(req.query.min_score);
      if (req.query.max_score) filter[scoreKey].$lte = parseFloat(req.query.max_score);
    }

    const sort = { [`analysis.scores.${sortField}`]: order };
    const result = await store.queryScreensPaginated({ filter, sort, page, limit });

    result.screens = result.screens.map(s => ({
      ...s,
      image_url: screenUrl(s.industry, s.file_path),
    }));

    res.json({
      screens: result.screens,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Screen SOM (Structural Object Model) ─────────────────────────────
// NOTE: SOM routes must come BEFORE /api/screens/:id to avoid :id matching "apple_22/som"

router.get('/api/screens/:id/som', async (req, res) => {
  try {
    const screen = await store.getScreen(req.params.id);
    if (!screen) return res.status(404).json({ error: 'Screen not found' });
    if (!screen.som) return res.status(404).json({ error: 'No SOM generated for this screen yet' });

    // Validate scaling params
    const hasWidth = req.query.target_width !== undefined;
    const hasHeight = req.query.target_height !== undefined;
    if (hasWidth !== hasHeight) {
      return res.status(400).json({ error: 'Both target_width and target_height are required for scaling' });
    }
    if (hasWidth) {
      const tw = parseInt(req.query.target_width, 10);
      const th = parseInt(req.query.target_height, 10);
      if (isNaN(tw) || isNaN(th) || tw <= 0 || th <= 0) {
        return res.status(400).json({ error: 'target_width and target_height must be positive integers' });
      }
      return res.json(scaleSOM(screen.som, tw, th));
    }

    res.json(screen.som);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/api/screens/:id/som', async (req, res) => {
  try {
    const screen = await store.getScreen(req.params.id);
    if (!screen) return res.status(404).json({ error: 'Screen not found' });

    const som = req.body;
    if (!som || !som.root) return res.status(400).json({ error: 'Request body must be a SOM with a root node' });

    const validation = validateSOM(som);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Invalid SOM', details: validation.errors });
    }

    // Auto-upgrade v1 → v2 on save
    const upgraded = (!som.version || som.version < 2) ? upgradeToV2(som) : som;
    const cleaned = prepareSOM(upgraded);
    await store.updateSOM(req.params.id, cleaned);

    res.json({ ok: true, screen_id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/screens/:id/som/roles', async (req, res) => {
  try {
    const screen = await store.getScreen(req.params.id);
    if (!screen) return res.status(404).json({ error: 'Screen not found' });
    if (!screen.som) return res.status(400).json({ error: 'No SOM to assign roles to' });

    const v2 = upgradeToV2(screen.som);

    // Apply manual overrides: { "node-name": "category/role" }
    const overrides = req.body?.overrides;
    if (overrides && typeof overrides === 'object') {
      (function applyOverrides(node) {
        const key = node.name;
        if (key && overrides[key]) {
          const parts = overrides[key].split('/');
          if (parts.length === 2) {
            node.roleCategory = parts[0];
            node.role = parts[1];
          }
        }
        if (Array.isArray(node.children)) node.children.forEach(applyOverrides);
      })(v2.root);
    }

    const cleaned = prepareSOM(v2);
    await store.updateSOM(req.params.id, cleaned);

    // Build response using assignRolesTree which computes actual confidence from assignRole
    const { roleMap, unknowns, confidence } = assignRolesTree(cleaned.root);

    res.json({
      screen_id: req.params.id,
      role_map: roleMap,
      unknown_nodes: unknowns,
      overall_confidence: confidence,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/som/merge', async (req, res) => {
  try {
    const { content_som_id, style_som_id, mapping, options } = req.body || {};
    if (!content_som_id || !style_som_id) {
      return res.status(400).json({ error: 'content_som_id and style_som_id are required' });
    }

    const [contentDoc, styleDoc] = await Promise.all([
      store.getScreenSOM(content_som_id),
      store.getScreenSOM(style_som_id),
    ]);

    if (!contentDoc) return res.status(404).json({ error: `Screen not found: ${content_som_id}` });
    if (!styleDoc) return res.status(404).json({ error: `Screen not found: ${style_som_id}` });
    if (!contentDoc.som) return res.status(400).json({ error: `No SOM for content screen: ${content_som_id}` });
    if (!styleDoc.som) return res.status(400).json({ error: `No SOM for style screen: ${style_som_id}` });

    const result = mergeSOM(contentDoc.som, styleDoc.som, mapping || 'auto', options || {});

    // Optional scaling
    if (options?.target_width && options?.target_height) {
      result.merged_som = scaleSOM(result.merged_som, options.target_width, options.target_height);
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Single Screen ──────────────────────────────────────────────────────

router.get('/api/screens/:id', async (req, res) => {
  try {
    const screen = await store.getScreen(req.params.id);
    if (!screen) return res.status(404).json({ error: 'Screen not found' });
    screen.image_url = screenUrl(screen.industry, screen.file_path);
    res.json(screen);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/screens/:id/image', async (req, res) => {
  try {
    const screen = await store.getScreen(req.params.id);
    if (!screen) return res.status(404).json({ error: 'Screen not found' });
    const filePath = path.join(PATHS.screens, screen.industry, screen.file_path);
    if (!await fs.pathExists(filePath)) return res.status(404).json({ error: 'Image file not found' });
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Similar Screens ───────────────────────────────────────────────────

router.get('/api/similar/:screenId', async (req, res) => {
  try {
    const anchor = await store.getScreen(req.params.screenId);
    if (!anchor) return res.status(404).json({ error: 'Screen not found' });

    const filter = {};
    if (req.query.industry) filter.industry = req.query.industry;
    if (req.query.brand) filter.brand = parseMultiFilter(req.query.brand);
    const allScreens = await store.getScreensWithFingerprints(filter);

    const presetName = req.query.preset || 'default';
    const weights = WEIGHT_PRESETS[presetName] || WEIGHT_PRESETS.default;
    const top = Math.min(parseInt(req.query.top) || 12, 50);

    const maxPerApp = Math.max(1, parseInt(req.query.max_per_app) || 3);
    const results = findSimilar(anchor, allScreens, { weights, top, maxPerApp });

    const screenMap = new Map(allScreens.map(s => [s.screen_id, s]));
    const enriched = results.map(r => {
      const screen = screenMap.get(r.screen_id);
      return {
        screen_id: r.screen_id,
        industry: r.industry,
        file_path: screen?.file_path,
        image_url: screenUrl(r.industry, screen?.file_path),
        similarity: r.similarity,
        analysis: screen?.analysis,
        fingerprint: screen?.fingerprint,
      };
    });

    res.json({
      anchor: req.params.screenId,
      preset: presetName,
      weights,
      results: enriched,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Scatter Plot Data ─────────────────────────────────────────────────

router.get('/api/scatter', async (req, res) => {
  try {
    const xField = req.query.x || 'calm_energetic';
    const yField = req.query.y || 'premium_accessible';

    if (!SCORE_FIELDS[xField] || !SCORE_FIELDS[yField]) {
      return res.status(400).json({ error: 'Invalid score field' });
    }

    const filter = {};
    if (req.query.industry) filter.industry = parseMultiFilter(req.query.industry);
    if (req.query.brand) filter.brand = parseMultiFilter(req.query.brand);
    if (req.query.screen_type) filter['analysis.screen_type'] = parseMultiFilter(req.query.screen_type);
    if (req.query.mood) filter['fingerprint.design_mood'] = req.query.mood;

    const screens = await store.db.collection('screens')
      .find(filter)
      .project({
        screen_id: 1,
        industry: 1,
        brand: 1,
        file_path: 1,
        [`analysis.scores.${xField}`]: 1,
        [`analysis.scores.${yField}`]: 1,
        'analysis.scores.overall_quality': 1,
        'analysis.screen_type': 1,
        'analysis.verdict': 1,
      })
      .toArray();

    const points = screens.map(s => ({
      id: s.screen_id,
      industry: s.industry,
      brand: s.brand || '',
      file_path: s.file_path || '',
      x: s.analysis?.scores?.[xField] ?? 0,
      y: s.analysis?.scores?.[yField] ?? 0,
      quality: s.analysis?.scores?.overall_quality ?? 0,
      screen_type: s.analysis?.screen_type || '',
      verdict: s.analysis?.verdict || '',
    }));

    res.json({
      x_field: xField,
      y_field: yField,
      x_range: SCORE_FIELDS[xField],
      y_range: SCORE_FIELDS[yField],
      count: points.length,
      points,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Correlations ──────────────────────────────────────────────────────

let correlationCache = { data: null, ts: 0, key: '' };
const CORRELATION_TTL = 5 * 60 * 1000; // 5 minutes

const FIELD_ORDER = [...SCORE_FIELD_LISTS.core, ...SCORE_FIELD_LISTS.spectrum];
const FIELD_LABELS = Object.fromEntries(
  FIELD_ORDER.map(f => [f, f.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')])
);

function pearsonOnValues(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i]; sumY += ys[i];
    sumXY += xs[i] * ys[i];
    sumX2 += xs[i] * xs[i];
    sumY2 += ys[i] * ys[i];
  }
  const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

// Spearman rank correlation (Pearson on ranks) — more robust for ordinal integer scores
function rankArray(arr) {
  const indexed = arr.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length);
  let pos = 0;
  while (pos < indexed.length) {
    let end = pos + 1;
    while (end < indexed.length && indexed[end].v === indexed[pos].v) end++;
    const avgRank = (pos + end - 1) / 2 + 1; // average rank for ties
    for (let k = pos; k < end; k++) ranks[indexed[k].i] = avgRank;
    pos = end;
  }
  return ranks;
}

function spearman(xs, ys) {
  return pearsonOnValues(rankArray(xs), rankArray(ys));
}

// Semantic overlap pairs — correlations that are partly definitional, not purely visual
const SEMANTIC_OVERLAPS = new Set([
  'calm_confident|calm_energetic',
  'bold_forward|forward_conservative',
  'confident_tentative|calm_confident',
  'density|whitespace_ratio',
]);

function isSemanticOverlap(f1, f2) {
  return SEMANTIC_OVERLAPS.has(`${f1}|${f2}`) || SEMANTIC_OVERLAPS.has(`${f2}|${f1}`);
}

function strengthLabel(absR) {
  if (absR >= 0.5) return 'strong';
  if (absR >= 0.3) return 'moderate';
  if (absR >= 0.15) return 'weak';
  return 'negligible';
}

const FIELD_DESCRIPTIONS = {
  color_restraint: 'How well the design limits its color palette. High-scoring screens use fewer, more intentional colors.',
  hierarchy_clarity: 'How easy it is to tell what\'s most important on the screen.',
  glanceability: 'How quickly you can understand the screen\'s purpose at a glance.',
  density: 'How well the screen balances the amount of content with breathing room.',
  whitespace_ratio: 'How effectively the design uses empty space to separate and frame content.',
  brand_confidence: 'How strongly the design communicates a recognizable brand identity.',
  calm_confident: 'How composed and assured the design feels.',
  bold_forward: 'How progressive and daring the design is.',
  overall_quality: 'The overall design quality combining all factors.',
  calm_energetic: 'Where the design sits between serene and lively. Negative = calm, positive = energetic.',
  confident_tentative: 'Whether the design feels decisive or uncertain. Negative = bold, positive = cautious.',
  forward_conservative: 'How modern versus traditional the design is. Negative = cutting-edge, positive = conventional.',
  premium_accessible: 'Whether the design targets luxury or mass-market. Negative = exclusive, positive = approachable.',
  warm_clinical: 'The emotional temperature. Negative = friendly and human, positive = precise and institutional.',
};

function generatePairNarrative(fieldA, fieldB, r, strengthStr, overlap) {
  const labelA = FIELD_LABELS[fieldA];
  const labelB = FIELD_LABELS[fieldB];
  const descA = FIELD_DESCRIPTIONS[fieldA] || labelA;
  const descB = FIELD_DESCRIPTIONS[fieldB] || labelB;
  const absR = Math.abs(r);
  const direction = r > 0 ? 'positive' : 'negative';

  let narrative, implication;

  if (absR < 0.05) {
    narrative = `${labelA} and ${labelB} are essentially independent dimensions. Changing one has no measurable effect on the other across the screens analyzed.`;
    implication = `You can adjust ${labelA} freely without worrying about ${labelB}.`;
  } else if (r > 0.5) {
    narrative = `${labelA} and ${labelB} are tightly linked — screens that excel at one almost always excel at the other. This suggests they share a common design discipline: the intentionality that drives strong ${labelA.toLowerCase()} also produces strong ${labelB.toLowerCase()}. With a correlation of ${r.toFixed(2)}, this is one of the more reliable patterns in the dataset.`;
    implication = `Investing in ${labelA.toLowerCase()} will likely raise ${labelB.toLowerCase()} as well — they reinforce each other.`;
  } else if (r > 0.3) {
    narrative = `${labelA} and ${labelB} tend to move together, though not always in lockstep. Screens with higher ${labelA.toLowerCase()} frequently show stronger ${labelB.toLowerCase()}, but there is enough variation that you can push one without the other following automatically. The moderate correlation (${r.toFixed(2)}) indicates a real but flexible relationship.`;
    implication = `Improving ${labelA.toLowerCase()} gives you a tailwind on ${labelB.toLowerCase()}, but do not count on it — address both intentionally.`;
  } else if (r > 0.15) {
    narrative = `There is a mild positive association between ${labelA} and ${labelB}. They nudge in the same direction, but the link is weak enough that many screens break the pattern. This is not something to design around.`;
    implication = `Do not rely on ${labelA.toLowerCase()} to move ${labelB.toLowerCase()} — the connection is too loose to be actionable.`;
  } else if (r > 0.05) {
    narrative = `${labelA} and ${labelB} show a faint positive trend that barely registers in practice. Most design decisions affecting one will not meaningfully change the other.`;
    implication = `Treat these as independent — any apparent connection is too small to guide decisions.`;
  } else if (r > -0.15) {
    narrative = `${labelA} and ${labelB} show a faint negative trend that barely registers in practice. The slight tension between them is not strong enough to create real tradeoffs.`;
    implication = `Treat these as independent — the slight inverse tendency is not meaningful for design decisions.`;
  } else if (r > -0.3) {
    narrative = `There is a mild tension between ${labelA} and ${labelB}. Screens that push harder on one tend to score slightly lower on the other, though many designs manage both adequately. The association is real but weak.`;
    implication = `Be aware of a slight tradeoff, but do not assume you must sacrifice ${labelB.toLowerCase()} to get ${labelA.toLowerCase()}.`;
  } else if (r > -0.5) {
    narrative = `${labelA} and ${labelB} pull in opposite directions with meaningful force. Designs that prioritize one tend to give ground on the other, creating a genuine tension that skilled designers must navigate. The correlation of ${r.toFixed(2)} means this tradeoff shows up consistently across industries.`;
    implication = `Pushing ${labelA.toLowerCase()} higher will likely cost you ${labelB.toLowerCase()} — plan for the tradeoff.`;
  } else {
    narrative = `${labelA} and ${labelB} are in strong opposition — this is one of the hardest tradeoffs in the dataset. Screens that maximize one consistently sacrifice the other. With a correlation of ${r.toFixed(2)}, very few designs manage to score well on both simultaneously.`;
    implication = `You cannot easily have both high ${labelA.toLowerCase()} and high ${labelB.toLowerCase()} — pick your priority.`;
  }

  if (overlap) {
    narrative += ' Note: These dimensions share conceptual overlap in their definitions, so some of this correlation is expected rather than a design insight.';
  }

  return { narrative, design_implication: implication };
}

function clusterFields(matrix, fields, threshold = 0.55) {
  // Agglomerative clustering using distance = 1 - |r|
  let clusters = fields.map((f, i) => ({ members: [i], label: '' }));
  const dist = (a, b) => {
    // Average linkage between cluster members
    let sum = 0, count = 0;
    for (const i of a.members) {
      for (const j of b.members) {
        sum += 1 - Math.abs(matrix[i][j]);
        count++;
      }
    }
    return sum / count;
  };

  while (clusters.length > 2) {
    let bestDist = Infinity, bestI = -1, bestJ = -1;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = dist(clusters[i], clusters[j]);
        if (d < bestDist) { bestDist = d; bestI = i; bestJ = j; }
      }
    }
    if (bestDist > threshold) break;
    const merged = { members: [...clusters[bestI].members, ...clusters[bestJ].members], label: '' };
    clusters = clusters.filter((_, idx) => idx !== bestI && idx !== bestJ);
    clusters.push(merged);
  }

  // Auto-label clusters — each field maps to a descriptive label for its primary theme
  const FIELD_THEME = {
    overall_quality: 'Quality Fundamentals',
    hierarchy_clarity: 'Quality Fundamentals',
    glanceability: 'Quality Fundamentals',
    color_restraint: 'Visual Restraint',
    whitespace_ratio: 'Visual Restraint',
    calm_energetic: 'Visual Restraint',
    bold_forward: 'Design Energy',
    density: 'Design Energy',
    calm_confident: 'Confidence & Trust',
    brand_confidence: 'Confidence & Trust',
    confident_tentative: 'Confidence & Trust',
    premium_accessible: 'Audience Positioning',
    warm_clinical: 'Emotional Tone',
    forward_conservative: 'Innovation Stance',
  };

  const usedLabels = new Set();
  return clusters.map((c, id) => {
    const memberFields = c.members.map(i => fields[i]);
    // Pick the most common theme among members
    const themeCounts = {};
    for (const f of memberFields) {
      const t = FIELD_THEME[f] || 'Mixed';
      themeCounts[t] = (themeCounts[t] || 0) + 1;
    }
    let label = Object.entries(themeCounts).sort((a, b) => b[1] - a[1])[0][0];
    // Deduplicate labels
    if (usedLabels.has(label)) {
      // For single-field clusters, use the field's own name
      if (memberFields.length === 1) {
        label = FIELD_LABELS[memberFields[0]] || label;
      } else {
        label = label + ' II';
      }
    }
    usedLabels.add(label);
    return { id, label, fields: memberFields };
  });
}

function buildDriverAnalysis(matrix, fields, target) {
  const ti = fields.indexOf(target);
  if (ti === -1) return [];
  return fields
    .map((f, i) => ({ field: f, r: +matrix[ti][i].toFixed(3), absR: Math.abs(matrix[ti][i]) }))
    .filter(d => d.field !== target)
    .sort((a, b) => b.absR - a.absR)
    .map(d => {
      const dir = d.r > 0 ? 'positive' : 'negative';
      const strength = d.absR > 0.5 ? 'strongly' : d.absR > 0.3 ? 'moderately' : 'weakly';
      const verb = d.r > 0 ? 'rises with' : 'falls as';
      const overlap = isSemanticOverlap(d.field, target);
      return {
        field: d.field,
        r: d.r,
        direction: dir,
        strength: strengthLabel(d.absR),
        semantic_overlap: overlap,
        insight: `${FIELD_LABELS[d.field]} ${strength} ${verb} ${FIELD_LABELS[target]}.` + (overlap ? ' (shared definition — interpret with care)' : ''),
      };
    });
}

router.get('/api/correlations', async (req, res) => {
  try {
    const cacheKey = (req.query.industry || '') + '|' + (req.query.bucket || '');
    const now = Date.now();
    if (correlationCache.data && correlationCache.key === cacheKey && (now - correlationCache.ts) < CORRELATION_TTL) {
      return res.json(correlationCache.data);
    }

    const filter = {};
    if (req.query.industry) filter.industry = parseMultiFilter(req.query.industry);
    if (req.query.bucket) {
      const bucket = await store.getBucket(req.query.bucket);
      if (bucket && bucket.screen_ids.length) filter.screen_id = { $in: bucket.screen_ids };
    }

    // Fetch all scores
    const projection = { industry: 1 };
    for (const f of FIELD_ORDER) projection[`analysis.scores.${f}`] = 1;
    const screens = await store.db.collection('screens').find(filter).project(projection).toArray();

    // Extract score vectors per field
    const vectors = {};
    for (const f of FIELD_ORDER) vectors[f] = [];
    const industries = [];

    for (const s of screens) {
      const scores = s.analysis?.scores;
      if (!scores) continue;
      // Only include screens that have all fields
      const allValid = FIELD_ORDER.every(f => typeof scores[f] === 'number');
      if (!allValid) continue;
      for (const f of FIELD_ORDER) vectors[f].push(scores[f]);
      industries.push(s.industry);
    }

    const count = vectors[FIELD_ORDER[0]].length;
    const n = FIELD_ORDER.length;

    // Pre-compute ranks once per field (avoids 182 sorts → only 14)
    const rankedVectors = {};
    for (const f of FIELD_ORDER) rankedVectors[f] = rankArray(vectors[f]);

    // Compute 14x14 Spearman rank correlation matrix (robust for ordinal integer scores)
    const matrix = Array.from({ length: n }, () => Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      matrix[i][i] = 1.0;
      for (let j = i + 1; j < n; j++) {
        const r = pearsonOnValues(rankedVectors[FIELD_ORDER[i]], rankedVectors[FIELD_ORDER[j]]);
        matrix[i][j] = +r.toFixed(4);
        matrix[j][i] = +r.toFixed(4);
      }
    }

    // Edges: pairs with |r| > 0.15 (effect-size threshold — at n=4600 even tiny r is significant)
    const edges = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(matrix[i][j]) > 0.15) {
          const f1 = FIELD_ORDER[i], f2 = FIELD_ORDER[j];
          edges.push({
            from: f1, to: f2, r: matrix[i][j],
            strength: strengthLabel(Math.abs(matrix[i][j])),
            semantic_overlap: isSemanticOverlap(f1, f2),
          });
        }
      }
    }
    edges.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

    // Clusters
    const clusters = clusterFields(matrix, FIELD_ORDER);

    // Driver analysis for 3 key outcomes
    const drivers = {
      overall_quality: buildDriverAnalysis(matrix, FIELD_ORDER, 'overall_quality'),
      calm_confident: buildDriverAnalysis(matrix, FIELD_ORDER, 'calm_confident'),
      bold_forward: buildDriverAnalysis(matrix, FIELD_ORDER, 'bold_forward'),
    };

    // Top 6 tradeoffs (most negatively correlated pairs)
    const allPairs = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        allPairs.push({ i, j, r: matrix[i][j] });
      }
    }
    const negativePairs = allPairs.filter(p => p.r < -0.1);
    negativePairs.sort((a, b) => a.r - b.r);

    // Build industry index map in one pass, then compute means
    const industryIndices = {};
    for (let k = 0; k < industries.length; k++) {
      (industryIndices[industries[k]] ??= []).push(k);
    }
    const industryMeans = {};
    for (const [ind, idx] of Object.entries(industryIndices)) {
      industryMeans[ind] = {};
      for (const f of FIELD_ORDER) {
        let sum = 0;
        for (const k of idx) sum += vectors[f][k];
        industryMeans[ind][f] = +(sum / idx.length).toFixed(2);
      }
    }
    const industrySet = Object.keys(industryIndices);

    const tradeoffs = negativePairs.slice(0, 6).map(p => {
      const f1 = FIELD_ORDER[p.i], f2 = FIELD_ORDER[p.j];
      const byIndustry = {};
      for (const ind of industrySet) {
        byIndustry[ind] = { x_mean: industryMeans[ind][f1], y_mean: industryMeans[ind][f2] };
      }
      return {
        pair: [f1, f2],
        r: +p.r.toFixed(4),
        insight: `${FIELD_LABELS[f1]} and ${FIELD_LABELS[f2]} pull in opposite directions — screens that score high on one tend to score low on the other.`,
        by_industry: byIndustry,
      };
    });

    // Design lever cards: top 8 strongest correlations (positive and negative)
    const sortedByStrength = [...allPairs].sort((a, b) => Math.abs(b.r) - Math.abs(a.r)).slice(0, 8);
    const levers = sortedByStrength.map(p => {
      const trigger = FIELD_ORDER[p.i];
      const target = FIELD_ORDER[p.j];
      if (p.r > 0) {
        return {
          trigger,
          effect_up: [target],
          effect_down: [],
          summary: `Increasing ${FIELD_LABELS[trigger]} tends to raise ${FIELD_LABELS[target]}.`,
        };
      } else {
        return {
          trigger,
          effect_up: [],
          effect_down: [target],
          summary: `Pushing ${FIELD_LABELS[trigger]} higher comes at the cost of ${FIELD_LABELS[target]}.`,
        };
      }
    });

    // Pair explanations — plain-English lookup for every unique pair
    const pairExplanations = {};
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const f1 = FIELD_ORDER[i], f2 = FIELD_ORDER[j];
        const r = matrix[i][j];
        const [sortedA, sortedB] = f1 < f2 ? [f1, f2] : [f2, f1];
        const key = `${sortedA}|${sortedB}`;
        const absR = Math.abs(r);
        const overlap = isSemanticOverlap(f1, f2);
        const strength = strengthLabel(absR);
        const direction = r > 0 ? 'positive' : (r < 0 ? 'negative' : 'neutral');
        const { narrative, design_implication } = absR > 0.05
          ? generatePairNarrative(sortedA, sortedB, r, strength, overlap)
          : { narrative: `${FIELD_LABELS[sortedA]} and ${FIELD_LABELS[sortedB]} are independent dimensions. Changing one has no measurable effect on the other.`, design_implication: `These can be adjusted independently — no tradeoff or synergy to consider.` };

        pairExplanations[key] = {
          field_a: sortedA,
          field_b: sortedB,
          label_a: FIELD_LABELS[sortedA],
          label_b: FIELD_LABELS[sortedB],
          r: +r.toFixed(4),
          strength,
          direction,
          semantic_overlap: overlap,
          narrative,
          design_implication,
          description_a: FIELD_DESCRIPTIONS[sortedA] || '',
          description_b: FIELD_DESCRIPTIONS[sortedB] || '',
        };
      }
    }

    // Global averages and standard deviations for the mixer
    const globalAverages = {};
    const globalStddevs = {};
    for (const f of FIELD_ORDER) {
      const vals = vectors[f];
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      globalAverages[f] = +mean.toFixed(2);
      const variance = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length;
      globalStddevs[f] = +Math.sqrt(variance).toFixed(3);
    }

    const result = {
      fields: FIELD_ORDER,
      field_labels: FIELD_LABELS,
      method: 'spearman',
      count,
      matrix,
      global_averages: globalAverages,
      global_stddevs: globalStddevs,
      clusters,
      edges,
      drivers,
      tradeoffs,
      levers,
      pair_explanations: pairExplanations,
    };

    correlationCache = { data: result, ts: now, key: cacheKey };
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Correlation Match (find screens closest to target scores) ─────────

router.post('/api/correlations/match', async (req, res) => {
  try {
    const { targets, limit = 12, industry, bucket } = req.body || {};
    if (!targets || typeof targets !== 'object') {
      return res.status(400).json({ error: 'targets object required' });
    }

    const filter = {};
    if (industry) filter.industry = parseMultiFilter(industry);
    if (bucket) {
      const b = await store.getBucket(bucket);
      if (b && b.screen_ids.length) filter.screen_id = { $in: b.screen_ids };
    }

    const projection = { screen_id: 1, industry: 1, brand: 1, file_path: 1 };
    for (const f of FIELD_ORDER) projection[`analysis.scores.${f}`] = 1;
    const screens = await store.db.collection('screens').find(filter).project(projection).toArray();

    const scored = [];
    for (const s of screens) {
      const sc = s.analysis?.scores;
      if (!sc) continue;
      let dist = 0;
      let valid = true;
      for (const f of FIELD_ORDER) {
        if (typeof sc[f] !== 'number') { valid = false; break; }
        if (targets[f] !== undefined) {
          const range = SCORE_FIELDS[f][1] - SCORE_FIELDS[f][0];
          const d = (sc[f] - targets[f]) / range;
          dist += d * d;
        }
      }
      if (!valid) continue;
      scored.push({
        screen_id: s.screen_id,
        industry: s.industry,
        brand: s.brand || '',
        file_path: s.file_path,
        image_url: screenUrl(s.industry, s.file_path),
        distance: +Math.sqrt(dist).toFixed(4),
      });
    }

    scored.sort((a, b) => a.distance - b.distance);
    res.json({ screens: scored.slice(0, Math.min(limit, 24)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Benchmark ─────────────────────────────────────────────────────────

router.get('/api/benchmark', async (req, res) => {
  try {
    const { group_type = 'brand', group_value, benchmark = 'global', tab = 'core', benchmark_value } = req.query;
    if (!group_value) return res.status(400).json({ error: 'group_value required' });

    const data = await store.getBenchmarkData({
      groupType: group_type,
      groupValue: group_value,
      benchmark,
      tab,
      benchmarkValue: benchmark_value,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Delete Screens ─────────────────────────────────────────────────────

router.delete('/api/screens', async (req, res) => {
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ error: 'ids array required' });

    const deleted = [];
    const notFound = [];

    for (const id of ids) {
      const screen = await store.getScreen(id);
      if (!screen) { notFound.push(id); continue; }

      const filePath = path.join(PATHS.screens, screen.industry, screen.file_path);
      await fs.remove(filePath).catch(() => {});
      await store.db.collection('screens').deleteOne({ screen_id: id });
      deleted.push(id);
    }

    res.json({ deleted, notFound });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Reclassify Screens ─────────────────────────────────────────────────

router.patch('/api/screens', async (req, res) => {
  try {
    const { ids, screen_type } = req.body;
    if (!Array.isArray(ids) || ids.length === 0 || !screen_type)
      return res.status(400).json({ error: 'ids array and screen_type required' });

    const result = await store.db.collection('screens').updateMany(
      { screen_id: { $in: ids } },
      { $set: { 'analysis.screen_type': screen_type } }
    );

    res.json({ updated: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Buckets ───────────────────────────────────────────────────────────

router.get('/api/buckets', async (req, res) => {
  try {
    const buckets = await store.listBuckets();

    // Fetch preview thumbnails for each bucket (up to 4 screens)
    const previewLimit = 4;
    const allScreenIds = [...new Set(buckets.flatMap(b => (b.screen_ids || []).slice(0, previewLimit)))];
    let screenMap = {};
    if (allScreenIds.length > 0) {
      const screens = await store.db.collection('screens')
        .find({ screen_id: { $in: allScreenIds } })
        .project({ screen_id: 1, industry: 1, file_path: 1 })
        .toArray();
      for (const s of screens) {
        screenMap[s.screen_id] = screenUrl(s.industry, s.file_path);
      }
    }

    const bucketsWithPreviews = buckets.map(b => ({
      ...b,
      previews: (b.screen_ids || []).slice(0, previewLimit).map(id => screenMap[id]).filter(Boolean),
    }));

    res.json({ buckets: bucketsWithPreviews });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/buckets', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  try {
    await store.createBucket(name.trim());
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Bucket name already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/buckets/:id', async (req, res) => {
  try {
    const sort = req.query.sort || 'overall_quality';
    const order = req.query.order === 'asc' ? 1 : -1;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 48));

    const result = await store.getBucketScreensPaginated(req.params.id, { sort, order, page, limit });
    if (!result) return res.status(404).json({ error: 'Bucket not found' });

    result.screens = result.screens.map(s => ({
      ...s,
      image_url: screenUrl(s.industry, s.file_path),
    }));

    res.json({
      bucket: { _id: result.bucket._id, name: result.bucket.name, description: result.bucket.description, metadata: result.bucket.metadata, count: result.bucket.count },
      screens: result.screens,
      pagination: { page: result.page, limit: result.limit, total: result.total, totalPages: result.totalPages },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/buckets/:id', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  try {
    await store.renameBucket(req.params.id, name.trim());
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Bucket name already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/buckets/:id', async (req, res) => {
  try {
    await store.deleteBucket(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/buckets/:id/screens', async (req, res) => {
  const ids = req.body?.screen_ids;
  if (!Array.isArray(ids) || ids.length === 0)
    return res.status(400).json({ error: 'screen_ids array required' });
  try {
    const bucket = await store.addScreensToBucket(req.params.id, ids);
    res.json({ ok: true, count: bucket.count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/buckets/:id/screens', async (req, res) => {
  const ids = req.body?.screen_ids;
  if (!Array.isArray(ids) || ids.length === 0)
    return res.status(400).json({ error: 'screen_ids array required' });
  try {
    const bucket = await store.removeScreensFromBucket(req.params.id, ids);
    res.json({ ok: true, count: bucket.count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/buckets/:id/screen-ids', async (req, res) => {
  try {
    const screenIds = await store.getBucketScreenIds(req.params.id);
    res.json({ screen_ids: screenIds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/buckets/:id/discover', async (req, res) => {
  try {
    const bucket = await store.getBucket(req.params.id);
    if (!bucket) return res.status(404).json({ error: 'Bucket not found' });
    if (bucket.screen_ids.length === 0) return res.status(400).json({ error: 'Bucket needs at least one screen to discover from' });

    const preset = req.body?.preset || 'default';
    const limit = Math.min(parseInt(req.body?.limit) || 24, 100);
    const weights = WEIGHT_PRESETS[preset] || WEIGHT_PRESETS.default;

    const existingIds = new Set(bucket.screen_ids);
    const allScreens = await store.getScreensWithFingerprints({});

    // Use each bucket screen as an anchor
    const anchorScreens = allScreens.filter(s => existingIds.has(s.screen_id));
    const candidateScores = new Map(); // screen_id → best similarity score

    for (const anchor of anchorScreens) {
      const results = findSimilar(anchor, allScreens, { weights, top: 30, maxPerApp: 3 });
      for (const r of results) {
        if (existingIds.has(r.screen_id)) continue;
        const existing = candidateScores.get(r.screen_id);
        if (!existing || r.similarity.total > existing.total) {
          candidateScores.set(r.screen_id, r.similarity);
        }
      }
    }

    // Rank by best similarity, take top N
    const ranked = [...candidateScores.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, limit);

    const screenMap = new Map(allScreens.map(s => [s.screen_id, s]));
    const discovered = ranked.map(([id, similarity]) => {
      const s = screenMap.get(id);
      return {
        screen_id: id,
        industry: s?.industry,
        file_path: s?.file_path,
        image_url: screenUrl(s?.industry, s?.file_path),
        similarity: similarity.total,
        analysis: s?.analysis,
        fingerprint: s?.fingerprint,
      };
    });

    res.json({ discovered, count: discovered.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/buckets/:id/generate-metadata', async (req, res) => {
  try {
    const bucket = await store.getBucket(req.params.id);
    if (!bucket) return res.status(404).json({ error: 'Bucket not found' });
    if (bucket.screen_ids.length === 0) return res.status(400).json({ error: 'Bucket has no screens' });

    const screens = await store.db.collection('screens')
      .find({ screen_id: { $in: bucket.screen_ids } })
      .project({
        screen_id: 1, industry: 1,
        'analysis.scores': 1, 'analysis.verdict': 1, 'analysis.screen_type': 1,
        'fingerprint.style_tags': 1, 'fingerprint.design_mood': 1, 'fingerprint.layout_type': 1,
        brand: 1,
      })
      .toArray();

    // Compute stats from screen data
    const scoreFields = SCORE_FIELD_LISTS.core;
    const avgScores = {};
    for (const field of scoreFields) {
      const vals = screens.map(s => s.analysis?.scores?.[field]).filter(v => typeof v === 'number');
      avgScores[field] = vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : null;
    }

    const industryCounts = {};
    const brandCounts = {};
    const moodCounts = {};
    const screenTypeCounts = {};
    for (const s of screens) {
      if (s.industry) industryCounts[s.industry] = (industryCounts[s.industry] || 0) + 1;
      if (s.brand) brandCounts[s.brand] = (brandCounts[s.brand] || 0) + 1;
      const mood = s.fingerprint?.design_mood;
      if (mood) moodCounts[mood] = (moodCounts[mood] || 0) + 1;
      const st = s.analysis?.screen_type;
      if (st) screenTypeCounts[st] = (screenTypeCounts[st] || 0) + 1;
    }
    const topMood = Object.entries(moodCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'mixed';
    const topIndustry = Object.entries(industryCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'various';
    const industryCount = Object.keys(industryCounts).length;

    // Build summary text for Claude
    const summaries = screens.map(s => {
      const scores = s.analysis?.scores || {};
      const tags = s.fingerprint?.style_tags?.join(', ') || 'none';
      return `- ${s.screen_id} (${s.industry}): quality=${scores.overall_quality || '?'}, calm=${scores.calm_confident || '?'}, bold=${scores.bold_forward || '?'}, mood=${s.fingerprint?.design_mood || '?'}, tags=[${tags}], verdict: ${s.analysis?.verdict || 'none'}`;
    }).join('\n');

    const client = new Anthropic();
    const message = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `You are a senior design strategist writing an editorial analysis of a curated collection of ${screens.length} UI screens in a bucket named "${bucket.name}".

Write with the authority and clarity of a design magazine — concise, opinionated, and actionable. No filler.

Return a JSON object with:
- "editorial_summary": A 2-4 sentence editorial paragraph. Write like Monocle or Bloomberg Businessweek — sharp, authoritative, specific. Reference actual patterns you observe. No generic statements.
- "patterns": Array of exactly 3 objects, each with "title" (bold 3-5 word lead-in), "detail" (1-2 sentences expanding on the pattern), and "screen_ids" (array of 3-5 screen_id strings from the list below that best exemplify this pattern). Focus on recurring visual/UX patterns.
- "insights": Array of exactly 3 objects, each with "title" (bold 3-5 word lead-in), "detail" (1-2 sentences of actionable design insight), and "screen_ids" (array of 3-5 screen_id strings that best illustrate this insight). Be specific and opinionated.
- "recommendations": Array of exactly 3 objects, each with "title" (bold 3-5 word lead-in), "detail" (1-2 sentences of concrete recommendation), and "screen_ids" (array of 3-5 screen_id strings that serve as reference examples for this recommendation).
- "mood_summary": A single crisp phrase (2-3 words max) capturing the collection's dominant design mood.

IMPORTANT: "screen_ids" must use exact IDs from the list below. Pick the screens that most clearly demonstrate each point.

Screens:\n${summaries}\n\nRespond ONLY with valid JSON, no markdown fences.`
      }],
    });

    let text = message.content[0].text.trim();
    // Strip markdown fences if Claude wrapped the JSON
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }
    let aiOutput;
    try {
      aiOutput = JSON.parse(text);
    } catch {
      aiOutput = {
        editorial_summary: text.slice(0, 300),
        patterns: [], insights: [], recommendations: [],
        mood_summary: 'mixed',
      };
    }

    // Merge AI output with computed stats
    const metadata = {
      ...aiOutput,
      // Keep legacy fields for backwards compat
      description: aiOutput.editorial_summary || aiOutput.description || '',
      stats: {
        screen_count: screens.length,
        industry_count: industryCount,
        top_industry: topIndustry,
        top_mood: topMood,
        // Legacy 3-field names (kept for backward compat)
        avg_quality: avgScores.overall_quality,
        avg_calm: avgScores.calm_confident,
        avg_bold: avgScores.bold_forward,
        // All 9 core metrics
        avg_color_restraint: avgScores.color_restraint,
        avg_hierarchy_clarity: avgScores.hierarchy_clarity,
        avg_glanceability: avgScores.glanceability,
        avg_density: avgScores.density,
        avg_whitespace_ratio: avgScores.whitespace_ratio,
        avg_brand_confidence: avgScores.brand_confidence,
        industries: industryCounts,
        brands: brandCounts,
        moods: moodCounts,
        screen_types: screenTypeCounts,
      },
      generated_at: new Date().toISOString(),
    };

    await store.updateBucketMetadata(req.params.id, metadata);
    res.json({ ok: true, metadata });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── API: Reference Templates ───────────────────────────────────────

router.put('/api/reference-templates', async (req, res) => {
  try {
    const data = req.body;
    if (!data || !data.som || !data.som.root) {
      return res.status(400).json({ error: 'Request body must include a som with a root node' });
    }
    if (!data.brandId || !data.screenType) {
      return res.status(400).json({ error: 'brandId and screenType are required' });
    }

    const validation = validateSOM(data.som);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Invalid SOM', details: validation.errors });
    }

    const upgraded = (!data.som.version || data.som.version < 2) ? upgradeToV2(data.som) : data.som;
    const cleaned = prepareSOM(upgraded);
    data.som = cleaned;

    const result = await store.saveReferenceTemplate(data);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/reference-templates/:id', async (req, res) => {
  try {
    const template = await store.getReferenceTemplate(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });

    if (req.query.includeLineage === 'true') {
      const lineage = [template];
      let current = template;
      while (current.supersedes) {
        const prev = await store.getReferenceTemplate(current.supersedes);
        if (!prev) break;
        lineage.push(prev);
        current = prev;
      }
      return res.json({ template, lineage });
    }

    res.json(template);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/reference-templates/find', async (req, res) => {
  try {
    const { screenType, brandId, tags, mood, platform, limit } = req.body || {};
    if (!screenType) return res.status(400).json({ error: 'screenType is required' });

    const results = await store.findReferenceTemplates(screenType, { brandId, tags, mood, platform, limit });
    res.json({ templates: results, count: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/reference-templates', async (req, res) => {
  try {
    const options = {};
    if (req.query.brandId) options.brandId = req.query.brandId;
    if (req.query.screenType) options.screenType = req.query.screenType;
    if (req.query.headsOnly !== undefined) options.headsOnly = req.query.headsOnly !== 'false';

    const templates = await store.listReferenceTemplates(options);
    res.json({ templates, count: templates.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/reference-templates/:id/deprecate', async (req, res) => {
  try {
    const { reason } = req.body || {};
    const result = await store.deprecateReferenceTemplate(req.params.id, reason || null);
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Template not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Rubric ─────────────────────────────────────────────────────────────

router.get('/api/rubric', async (req, res) => {
  try {
    const rubricPath = path.join(PATHS.config, 'rubric.md');
    const text = await fs.readFile(rubricPath, 'utf-8');
    res.type('text/plain').send(text);
  } catch (err) {
    res.status(500).json({ error: 'Rubric file not found' });
  }
});

// ─── Protected Static Files ──────────────────────────────────────────────────

router.use('/frontend', requireAuth, express.static(path.join(__dirname, 'frontend')));
router.use('/screens', requireAuth, express.static(PATHS.screens, { maxAge: '1d' }));

router.get('/guide.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'guide.html'));
});

// ─── SPA Fallback ────────────────────────────────────────────────────────────

router.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

router.get('/{*path}', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// ─── Mount router at BASE_PATH ──────────────────────────────────────────────

app.use(BASE_PATH || '/', router);

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}${BASE_PATH || ''}`;
  console.log(`\n  Osiris running at ${url}\n`);
});
