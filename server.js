import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { Store } from './src/store.js';
import { PATHS, CLAUDE_MODEL, SCORE_FIELDS as SCORE_FIELD_LISTS, brandDisplayName } from './src/utils.js';
import { findSimilar, WEIGHT_PRESETS } from './src/similarity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, '.env'), override: true });

const PORT = process.env.PORT || 3000;
const BASE_PATH = process.env.BASE_PATH || '';
const app = express();
const router = express.Router();
const store = new Store();

// Helper to build image URLs with base path
const screenUrl = (industry, filePath) => `${BASE_PATH}/screens/${industry}/${filePath}`;

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

// ─── Static Files ────────────────────────────────────────────────────────────

router.use('/frontend', express.static(path.join(__dirname, 'frontend')));
router.use('/screens', express.static(PATHS.screens, { maxAge: '1d' }));

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
    const scoreFields = ['overall_quality', 'calm_confident', 'bold_forward', 'color_restraint', 'hierarchy_clarity', 'glanceability', 'brand_confidence'];
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
        avg_quality: avgScores.overall_quality,
        avg_calm: avgScores.calm_confident,
        avg_bold: avgScores.bold_forward,
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

// ─── API: Distillations (for bucket import) ──────────────────────────────────

router.get('/api/distillations', async (req, res) => {
  try {
    const distillations = await store.listDistillations();
    res.json({ distillations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/buckets/import-distillation', async (req, res) => {
  const { distillation_name, bucket_name } = req.body;
  if (!distillation_name) return res.status(400).json({ error: 'distillation_name required' });
  try {
    const distillation = await store.getDistillation(distillation_name);
    if (!distillation) return res.status(404).json({ error: 'Distillation not found' });

    const name = bucket_name || distillation_name;
    try {
      await store.createBucket(name);
    } catch (err) {
      if (err.code !== 11000) throw err;
      // Bucket already exists, will just add screens
    }

    // Find the bucket by name
    const bucket = await store.db.collection('buckets').findOne({ name });
    await store.addScreensToBucket(bucket._id.toString(), distillation.screen_ids);

    res.json({ ok: true, bucket_name: name, count: distillation.screen_ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SPA Fallback ────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

router.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// ─── Mount router at BASE_PATH ──────────────────────────────────────────────

app.use(BASE_PATH || '/', router);

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}${BASE_PATH || ''}`;
  console.log(`\n  Osiris running at ${url}\n`);
});
