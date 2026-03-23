// Osiris Remote MCP Endpoint — Streamable HTTP transport
// Serves MCP tools directly from the Express server, eliminating the local stdio proxy.
//
// Usage: import { createMcpRouter } from './src/mcp-endpoint.js'
//        app.use(BASE_PATH + '/mcp', createMcpRouter({ store, findSimilar, ... }))

import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import express from 'express';
import path from 'path';
import fs from 'fs-extra';

// ─── Helpers ────────────────────────────────────────────────────────────────

function textResult(content) {
  return { content: [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content, null, 2) }] };
}

// ─── MCP Server Factory ────────────────────────────────────────────────────

function createMcpServer(deps) {
  const { store, findSimilar, WEIGHT_PRESETS, validateAndPrepareSOM, upgradeToV2,
    assignRolesTree, prepareSOM, mergeSOM, scaleSOM, classifyChanges,
    extractPatterns, extractPatternsFromTemplates, extractStyleGuide,
    screenUrl, PATHS, brandDisplayName } = deps;

  const server = new McpServer({ name: 'osiris', version: '1.0.0' });

  // ═══ SLICE 1 — Read Buckets and Insights ═══

  server.tool(
    'osiris_list_buckets',
    'List all curated design buckets in Osiris. Returns bucket names, IDs, screen counts, and whether AI-generated insights exist.',
    {},
    async () => {
      const data = await store.db.collection('buckets').find({}).toArray();
      const buckets = data.map(b => ({
        id: b._id,
        name: b.name,
        count: b.count || (b.screen_ids || []).length,
        has_insights: !!(b.metadata?.editorial_summary),
        description: b.metadata?.editorial_summary || b.description || null,
        mood: b.metadata?.mood_summary || null,
        previews: b.previews || [],
      }));
      return textResult({ buckets });
    }
  );

  server.tool(
    'osiris_get_bucket_insights',
    'Get AI-generated editorial insights for a specific bucket: editorial summary, mood, patterns, insights, recommendations, and average scores.',
    { bucket_id: z.string().describe('Bucket ID (from osiris_list_buckets)') },
    async ({ bucket_id }) => {
      const bucket = await store.getBucket(bucket_id);
      if (!bucket) throw new Error('Bucket not found');
      const meta = bucket.metadata || {};
      const result = {
        name: bucket.name,
        editorial_summary: meta.editorial_summary || meta.description || null,
        mood_summary: meta.mood_summary || null,
        patterns: meta.patterns || [],
        insights: meta.insights || [],
        recommendations: meta.recommendations || [],
        stats: meta.stats || null,
        generated_at: meta.generated_at || null,
      };
      if (!result.editorial_summary) {
        result._note = 'No insights generated yet. Use the Osiris web UI to generate metadata for this bucket first.';
      }
      return textResult(result);
    }
  );

  server.tool(
    'osiris_get_bucket_screens',
    'Get top screens from a bucket, sorted by quality. Returns scores, fingerprints, verdicts, and image URLs for design reference.',
    {
      bucket_id: z.string().describe('Bucket ID'),
      limit: z.coerce.number().min(1).max(48).default(12).describe('Number of screens to return (default 12)'),
      sort: z.string().default('overall_quality').describe('Score field to sort by (default: overall_quality)'),
    },
    async ({ bucket_id, limit, sort }) => {
      const bucket = await store.getBucket(bucket_id);
      if (!bucket) throw new Error('Bucket not found');
      const screenIds = bucket.screen_ids || [];
      const sortKey = `analysis.scores.${sort}`;
      const screens = await store.db.collection('screens')
        .find({ screen_id: { $in: screenIds } })
        .sort({ [sortKey]: -1 })
        .limit(limit)
        .toArray();
      const mapped = screens.map(s => ({
        screen_id: s.screen_id,
        industry: s.industry,
        brand: s.brand || null,
        image_url: screenUrl(s.industry, s.file_path),
        scores: s.analysis?.scores || {},
        verdict: s.analysis?.verdict || null,
        screen_type: s.analysis?.screen_type || null,
        style_tags: s.fingerprint?.style_tags || [],
        design_mood: s.fingerprint?.design_mood || null,
        layout_type: s.fingerprint?.layout_type || null,
      }));
      return textResult({
        bucket: bucket.name,
        count: mapped.length,
        total_in_bucket: screenIds.length,
        screens: mapped,
      });
    }
  );

  // ═══ SLICE 3 — Screen Detail + Scoring Rubric + Benchmarks ═══

  server.tool(
    'osiris_get_screen_detail',
    'Get full analysis for a single screen: all scores, verdict, color palette, typography, spatial layout, fingerprint, and image URL.',
    { screen_id: z.string().describe('Screen ID (from bucket screens or search results)') },
    async ({ screen_id }) => {
      const s = await store.getScreen(screen_id);
      if (!s) throw new Error('Screen not found');
      return textResult({
        screen_id: s.screen_id,
        industry: s.industry,
        brand: s.brand || null,
        image_url: screenUrl(s.industry, s.file_path),
        scores: s.analysis?.scores || {},
        verdict: s.analysis?.verdict || null,
        screen_type: s.analysis?.screen_type || null,
        color_palette: s.analysis?.color_palette || null,
        typography: s.analysis?.typography || null,
        spatial: s.analysis?.spatial || null,
        fingerprint: s.fingerprint || s.analysis?.fingerprint || null,
      });
    }
  );

  server.tool(
    'osiris_get_screen_image',
    'Get a screen screenshot as an image. Returns the actual PNG for visual reference.',
    { screen_id: z.string().describe('Screen ID') },
    async ({ screen_id }) => {
      const screen = await store.getScreen(screen_id);
      if (!screen) throw new Error('Screen not found');
      const filePath = path.join(PATHS.screens, screen.industry, screen.file_path);
      if (!await fs.pathExists(filePath)) throw new Error('Image file not found');
      const buffer = await fs.readFile(filePath);
      const base64 = buffer.toString('base64');
      const ext = path.extname(filePath).toLowerCase();
      const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
      return { content: [{ type: 'image', data: base64, mimeType }] };
    }
  );

  server.tool(
    'osiris_get_screen_som',
    'Get the cached Screen Object Model (SOM) for a screen — a recursive node tree decomposition. Returns 404 if no SOM has been generated yet. Optionally scales to target dimensions.',
    {
      screen_id: z.string().describe('Screen ID'),
      target_width: z.coerce.number().optional().describe('Target artboard width in pixels for scaling'),
      target_height: z.coerce.number().optional().describe('Target artboard height in pixels for scaling'),
    },
    async ({ screen_id, target_width, target_height }) => {
      const screen = await store.getScreen(screen_id);
      if (!screen) throw new Error('Screen not found');
      if (!screen.som) throw new Error('No SOM generated for this screen yet');
      if (target_width && target_height) {
        return textResult(scaleSOM(screen.som, target_width, target_height));
      }
      return textResult(screen.som);
    }
  );

  server.tool(
    'osiris_save_screen_som',
    'Save a Screen Object Model (SOM) to a screen. Validated and post-processed before storage.',
    {
      screen_id: z.string().describe('Screen ID to attach the SOM to'),
      som: z.object({
        referenceFrame: z.object({ width: z.number(), height: z.number() }).optional(),
        screenType: z.string().optional(),
        platform: z.string().optional(),
        version: z.number().optional(),
        root: z.any(),
      }).describe('The SOM JSON object with a root node tree'),
    },
    async ({ screen_id, som }) => {
      const screen = await store.getScreen(screen_id);
      if (!screen) throw new Error('Screen not found');
      if (!som || !som.root) throw new Error('SOM must have a root node');
      const result = validateAndPrepareSOM(som);
      if (result.error) throw new Error(`Invalid SOM: ${JSON.stringify(result.details)}`);
      await store.updateSOM(screen_id, result.som);
      return textResult({ ok: true, screen_id });
    }
  );

  server.tool(
    'osiris_assign_roles',
    'Assign semantic roles to all nodes in a screen SOM. Auto-detects roles from node names and structure.',
    {
      screen_id: z.string().describe('Screen ID with an existing SOM'),
      method: z.enum(['auto', 'ai_assisted']).default('auto').describe('Assignment method'),
      overrides: z.record(z.string()).optional().describe('Manual overrides: { "node-name": "category/role" }'),
    },
    async ({ screen_id, method, overrides }) => {
      const screen = await store.getScreen(screen_id);
      if (!screen) throw new Error('Screen not found');
      if (!screen.som) throw new Error('No SOM to assign roles to');
      const v2 = upgradeToV2(screen.som);
      if (overrides && typeof overrides === 'object') {
        (function applyOverrides(node) {
          const key = node.name;
          if (key && overrides[key]) {
            const parts = overrides[key].split('/');
            if (parts.length === 2) { node.roleCategory = parts[0]; node.role = parts[1]; }
          }
          if (Array.isArray(node.children)) node.children.forEach(applyOverrides);
        })(v2.root);
      }
      const cleaned = prepareSOM(v2);
      await store.updateSOM(screen_id, cleaned);
      const { roleMap, unknowns, confidence } = assignRolesTree(cleaned.root);
      return textResult({ screen_id, role_map: roleMap, unknown_nodes: unknowns, overall_confidence: confidence });
    }
  );

  server.tool(
    'osiris_merge_som',
    'Merge two SOMs: takes content from one screen and visual style from another. Both screens must have SOMs.',
    {
      content_som_id: z.string().describe('Screen ID to use as content source'),
      style_som_id: z.string().describe('Screen ID to use as style source'),
      mapping: z.union([z.literal('auto'), z.record(z.string())]).default('auto').describe('"auto" for automatic role matching, or a { contentNode: styleNode } map'),
      options: z.object({
        preserve_content_hierarchy: z.boolean().default(true),
        allow_overflow: z.boolean().default(true),
        overflow: z.enum(['repeat_pattern', 'truncate']).default('repeat_pattern'),
        underflow: z.enum(['hide_extra', 'placeholder']).default('hide_extra'),
        target_width: z.number().optional(),
        target_height: z.number().optional(),
      }).optional().describe('Merge options'),
    },
    async ({ content_som_id, style_som_id, mapping, options }) => {
      const [contentDoc, styleDoc] = await Promise.all([
        store.getScreenSOM(content_som_id),
        store.getScreenSOM(style_som_id),
      ]);
      if (!contentDoc) throw new Error(`Screen not found: ${content_som_id}`);
      if (!styleDoc) throw new Error(`Screen not found: ${style_som_id}`);
      if (!contentDoc.som) throw new Error(`No SOM for content screen: ${content_som_id}`);
      if (!styleDoc.som) throw new Error(`No SOM for style screen: ${style_som_id}`);
      const result = mergeSOM(contentDoc.som, styleDoc.som, mapping || 'auto', options || {});
      if (options?.target_width && options?.target_height) {
        result.merged_som = scaleSOM(result.merged_som, options.target_width, options.target_height);
      }
      return textResult(result);
    }
  );

  server.tool(
    'osiris_get_scoring_rubric',
    'Get the Osiris scoring rubric — the exact dimensions and scales used to evaluate UI designs.',
    {},
    async () => {
      const rubricPath = path.join(PATHS.config, 'rubric.md');
      const text = await fs.readFile(rubricPath, 'utf-8');
      return textResult(text);
    }
  );

  server.tool(
    'osiris_get_bucket_benchmarks',
    'Get benchmark scores for a bucket: average quality, calm_confident, bold_forward, and other metrics.',
    { bucket_id: z.string().describe('Bucket ID') },
    async ({ bucket_id }) => {
      const bucket = await store.getBucket(bucket_id);
      if (!bucket) throw new Error('Bucket not found');
      const stats = bucket.metadata?.stats || {};
      return textResult({
        bucket: bucket.name,
        benchmarks: {
          avg_quality: stats.avg_quality ?? null,
          avg_calm_confident: stats.avg_calm ?? null,
          avg_bold_forward: stats.avg_bold ?? null,
          avg_color_restraint: stats.avg_color_restraint ?? null,
          avg_hierarchy_clarity: stats.avg_hierarchy_clarity ?? null,
          avg_glanceability: stats.avg_glanceability ?? null,
          avg_density: stats.avg_density ?? null,
          avg_whitespace_ratio: stats.avg_whitespace_ratio ?? null,
          avg_brand_confidence: stats.avg_brand_confidence ?? null,
          screen_count: stats.screen_count ?? null,
          top_mood: stats.top_mood ?? null,
          industries: stats.industries ?? null,
        },
        _note: stats.avg_quality
          ? 'These are average scores across all screens in the bucket. Aim to meet or exceed these.'
          : 'No benchmark stats available. Generate metadata for this bucket in the Osiris web UI first.',
      });
    }
  );

  // ═══ SLICE 4 — Self-Evaluation Loop ═══

  server.tool(
    'osiris_score_comparison',
    'Compare your self-evaluated design scores against bucket benchmarks. Highlights gaps and identifies areas for iteration.',
    {
      design_scores: z.object({
        overall_quality: z.number().min(1).max(10),
        calm_confident: z.number().min(1).max(10),
        bold_forward: z.number().min(1).max(10),
        color_restraint: z.number().min(1).max(10).optional(),
        hierarchy_clarity: z.number().min(1).max(10).optional(),
        glanceability: z.number().min(1).max(10).optional(),
        density: z.number().min(1).max(10).optional(),
        whitespace_ratio: z.number().min(1).max(10).optional(),
        brand_confidence: z.number().min(1).max(10).optional(),
      }).describe('Your self-evaluated scores'),
      benchmark_scores: z.object({
        avg_quality: z.number().nullable(),
        avg_calm_confident: z.number().nullable(),
        avg_bold_forward: z.number().nullable(),
        avg_color_restraint: z.number().nullable().optional(),
        avg_hierarchy_clarity: z.number().nullable().optional(),
        avg_glanceability: z.number().nullable().optional(),
        avg_density: z.number().nullable().optional(),
        avg_whitespace_ratio: z.number().nullable().optional(),
        avg_brand_confidence: z.number().nullable().optional(),
      }).describe('Benchmark scores from osiris_get_bucket_benchmarks'),
    },
    async ({ design_scores, benchmark_scores }) => {
      const comparisons = [];
      const gaps = [];
      const pairs = [
        ['overall_quality', benchmark_scores.avg_quality, 'Overall Quality'],
        ['calm_confident', benchmark_scores.avg_calm_confident, 'Calm & Confident'],
        ['bold_forward', benchmark_scores.avg_bold_forward, 'Bold & Forward'],
        ['color_restraint', benchmark_scores.avg_color_restraint, 'Color Restraint'],
        ['hierarchy_clarity', benchmark_scores.avg_hierarchy_clarity, 'Hierarchy Clarity'],
        ['glanceability', benchmark_scores.avg_glanceability, 'Glanceability'],
        ['density', benchmark_scores.avg_density, 'Density'],
        ['whitespace_ratio', benchmark_scores.avg_whitespace_ratio, 'Whitespace Ratio'],
        ['brand_confidence', benchmark_scores.avg_brand_confidence, 'Brand Confidence'],
      ];
      for (const [key, benchmark, label] of pairs) {
        const yours = design_scores[key];
        if (yours === undefined || benchmark === null || benchmark === undefined) continue;
        const delta = +(yours - benchmark).toFixed(1);
        const status = delta >= 0 ? 'MEETS' : Math.abs(delta) > 1 ? 'BELOW' : 'CLOSE';
        comparisons.push({ metric: label, yours, benchmark: +benchmark.toFixed(1), delta, status });
        if (status === 'BELOW') gaps.push({ metric: label, gap: Math.abs(delta) });
      }
      const needs_iteration = gaps.length > 0;
      return textResult({
        scorecard: comparisons,
        gaps: gaps.length > 0 ? gaps : 'All metrics meet benchmarks.',
        needs_iteration,
        recommendation: needs_iteration
          ? `Focus on: ${gaps.map(g => `${g.metric} (${g.gap}pt below)`).join(', ')}. Iterate on these areas and re-evaluate.`
          : 'Design meets or exceeds all benchmarks. Ready for review.',
      });
    }
  );

  // ═══ SLICE 5 — Exploration Tools ═══

  server.tool(
    'osiris_find_similar',
    'Find screens visually and conceptually similar to a given screen across the full Osiris database.',
    {
      screen_id: z.string().describe('Screen ID to find similar screens for'),
      preset: z.enum(['default', 'visual', 'semantic', 'score']).default('default').describe('Similarity weight preset'),
      limit: z.coerce.number().min(1).max(50).default(12).describe('Number of results'),
    },
    async ({ screen_id, preset, limit }) => {
      const anchor = await store.getScreen(screen_id);
      if (!anchor) throw new Error('Screen not found');
      const allScreens = await store.getScreensWithFingerprints({});
      const weights = WEIGHT_PRESETS[preset] || WEIGHT_PRESETS.default;
      const results = findSimilar(anchor, allScreens, { weights, top: limit, maxPerApp: 3 });
      const screenMap = new Map(allScreens.map(s => [s.screen_id, s]));
      const enriched = results.map(r => {
        const screen = screenMap.get(r.screen_id);
        return {
          screen_id: r.screen_id,
          industry: r.industry,
          brand: screen?.brand || null,
          image_url: screenUrl(r.industry, screen?.file_path),
          similarity_score: r.similarity?.total ?? r.similarity,
          scores: screen?.analysis?.scores || {},
          verdict: screen?.analysis?.verdict || null,
          design_mood: screen?.fingerprint?.design_mood || null,
          style_tags: screen?.fingerprint?.style_tags || [],
        };
      });
      return textResult({ anchor: screen_id, preset, results: enriched });
    }
  );

  server.tool(
    'osiris_search_screens',
    'Search and filter screens across the full Osiris database by industry, screen type, mood, layout, tags, score range, free-text search, and sorting.',
    {
      q: z.string().optional().describe('Free-text search across screen verdicts'),
      industry: z.string().optional().describe('Filter by industry'),
      screen_type: z.string().optional().describe('Filter by screen type'),
      mood: z.string().optional().describe('Filter by design mood'),
      layout: z.string().optional().describe('Filter by layout type'),
      brand: z.string().optional().describe('Filter by brand slug'),
      tags: z.string().optional().describe('Comma-separated style tags'),
      min_score: z.coerce.number().optional().describe('Minimum score for the sort field'),
      sort: z.string().default('overall_quality').describe('Score field to sort by'),
      limit: z.coerce.number().min(1).max(48).default(12).describe('Number of results'),
    },
    async ({ q, industry, screen_type, mood, layout, brand, tags, min_score, sort, limit }) => {
      const filter = {};
      if (industry) filter.industry = industry;
      if (brand) filter.brand = brand;
      if (screen_type) filter['analysis.screen_type'] = screen_type;
      if (mood) filter['fingerprint.design_mood'] = mood;
      if (layout) filter['fingerprint.layout_type'] = layout;
      if (tags) filter['fingerprint.style_tags'] = { $in: tags.split(',') };
      if (q) filter.$text = { $search: q };
      const scoreKey = `analysis.scores.${sort}`;
      if (min_score) filter[scoreKey] = { $gte: min_score };
      const result = await store.queryScreensPaginated({
        filter, sort: { [scoreKey]: -1 }, page: 1, limit,
      });
      const screens = result.screens.map(s => ({
        screen_id: s.screen_id,
        industry: s.industry,
        brand: s.brand || null,
        image_url: screenUrl(s.industry, s.file_path),
        scores: s.analysis?.scores || {},
        verdict: s.analysis?.verdict || null,
        screen_type: s.analysis?.screen_type || null,
        design_mood: s.fingerprint?.design_mood || null,
        style_tags: s.fingerprint?.style_tags || [],
      }));
      return textResult({ total: result.total, showing: screens.length, screens });
    }
  );

  server.tool(
    'osiris_list_brands',
    'List all brands in the Osiris database, optionally filtered by industry.',
    { industry: z.string().optional().describe('Filter brands by industry') },
    async ({ industry }) => {
      const filter = {};
      if (industry) filter.industry = industry;
      const results = await store.db.collection('screens').aggregate([
        { $match: filter },
        { $group: { _id: { brand: '$brand', industry: '$industry' }, count: { $sum: 1 } } },
        { $sort: { '_id.brand': 1 } },
      ]).toArray();
      const brands = results
        .filter(r => r._id.brand)
        .map(r => ({ slug: r._id.brand, name: brandDisplayName(r._id.brand), industry: r._id.industry, count: r.count }));
      return textResult({ brands });
    }
  );

  // ═══ SLICE 6 — Reference Templates ═══

  server.tool(
    'osiris_save_reference_template',
    'Save a refined SOM as a reusable reference template.',
    {
      brandId: z.string().describe('Brand slug'),
      screenType: z.string().describe('Screen type'),
      som: z.object({
        referenceFrame: z.object({ width: z.number(), height: z.number() }).optional(),
        screenType: z.string().optional(),
        platform: z.string().optional(),
        version: z.number().optional(),
        root: z.any(),
      }).describe('The full SOM JSON object with a root node tree'),
      screenSubtype: z.string().optional().describe('More specific screen subtype'),
      tags: z.array(z.string()).optional().describe('Tags for matching'),
      mood: z.string().optional().describe('Design mood'),
      density: z.string().optional().describe('Content density'),
      platform: z.string().optional().describe('Target platform'),
      referenceFrame: z.object({ width: z.number(), height: z.number() }).optional().describe('Original frame dimensions'),
      slots: z.array(z.object({
        slotId: z.string(), nodeId: z.string(), role: z.string(),
        type: z.string(), defaultValue: z.any().optional(),
      })).optional().describe('Customizable slots in the template'),
      structure: z.object({
        sectionCount: z.number().optional(), hasCTA: z.boolean().optional(),
        hasHero: z.boolean().optional(), hasBottomNav: z.boolean().optional(),
        cardCount: z.number().optional(),
      }).optional().describe('Structural summary'),
      sourceScreenId: z.string().optional().describe('Osiris screen ID this template was derived from'),
      refinedFromNodeId: z.string().optional().describe('Figma node ID of the refined frame'),
      supersedes: z.string().optional().describe('Template ID this supersedes'),
      version: z.number().optional().describe('Template version number'),
    },
    async (params) => {
      if (!params.som?.root) throw new Error('SOM must have a root node');
      const validated = validateAndPrepareSOM(params.som);
      if (validated.error) throw new Error(`Invalid SOM: ${JSON.stringify(validated.details)}`);
      params.som = validated.som;
      const result = await store.saveReferenceTemplate(params);
      return textResult({ ok: true, ...result });
    }
  );

  server.tool(
    'osiris_find_template',
    'Find the best matching reference template for a screen type.',
    {
      screenType: z.string().describe('Screen type to find templates for'),
      brandId: z.string().optional().describe('Brand slug'),
      tags: z.array(z.string()).optional().describe('Tags to match against'),
      mood: z.string().optional().describe('Design mood to match'),
      platform: z.string().optional().describe('Target platform'),
      limit: z.coerce.number().min(1).max(20).default(5).describe('Max templates to return'),
    },
    async ({ screenType, brandId, tags, mood, platform, limit }) => {
      const results = await store.findReferenceTemplates(screenType, { brandId, tags, mood, platform, limit });
      return textResult({ templates: results, count: results.length });
    }
  );

  server.tool(
    'osiris_get_template',
    'Get a reference template by ID. Optionally includes supersession lineage chain.',
    {
      template_id: z.string().describe('Template ID'),
      includeLineage: z.boolean().default(false).describe('Include supersession lineage chain'),
    },
    async ({ template_id, includeLineage }) => {
      const template = await store.getReferenceTemplate(template_id);
      if (!template) throw new Error('Template not found');
      if (includeLineage) {
        const lineage = [template];
        let current = template;
        while (current.supersedes) {
          const prev = await store.getReferenceTemplate(current.supersedes);
          if (!prev) break;
          lineage.push(prev);
          current = prev;
        }
        return textResult({ template, lineage });
      }
      return textResult({ template });
    }
  );

  server.tool(
    'osiris_list_templates',
    'List reference templates with summaries (SOM body excluded for performance).',
    {
      brandId: z.string().optional().describe('Filter by brand slug'),
      screenType: z.string().optional().describe('Filter by screen type'),
      headsOnly: z.boolean().default(true).describe('Only show latest generation per lineage'),
    },
    async ({ brandId, screenType, headsOnly }) => {
      const options = {};
      if (brandId) options.brandId = brandId;
      if (screenType) options.screenType = screenType;
      if (headsOnly !== undefined) options.headsOnly = headsOnly;
      const templates = await store.listReferenceTemplates(options);
      return textResult({ templates, count: templates.length });
    }
  );

  server.tool(
    'osiris_deprecate_template',
    'Soft-deprecate a reference template. Excluded from find results but accessible by ID.',
    {
      template_id: z.string().describe('Template ID to deprecate'),
      reason: z.string().optional().describe('Reason for deprecation'),
    },
    async ({ template_id, reason }) => {
      const result = await store.deprecateReferenceTemplate(template_id, reason || null);
      if (result.matchedCount === 0) throw new Error('Template not found');
      return textResult({ ok: true });
    }
  );

  // ═══ SLICE 7 — Property Patterns ═══

  server.tool(
    'osiris_extract_patterns',
    'Run the adversarial filter and pattern extraction on refinement records.',
    {
      brandId: z.string().optional().describe('Filter refinement records by brand'),
      screenType: z.string().optional().describe('Filter by screen type'),
      limit: z.coerce.number().optional().describe('Max refinement records to process'),
    },
    async ({ brandId, screenType, limit }) => {
      const query = {};
      if (brandId) query.brandId = brandId;
      if (screenType) query.screenType = screenType;
      if (limit) query.limit = limit;
      const records = await store.listRefinementRecords(query);
      if (records.length === 0) {
        return textResult({ ok: true, summary: { total: 0 }, patterns: { upserted: 0, updated: 0, total: 0 } });
      }
      const { records: classified, summary } = classifyChanges(records);
      const existingPatterns = await store.getPatterns({ brandId });
      const patterns = extractPatterns(classified, existingPatterns);
      const result = patterns.length > 0
        ? await store.bulkUpsertPatterns(patterns)
        : { upserted: 0, updated: 0, total: 0 };
      return textResult({ ok: true, summary, patterns: result });
    }
  );

  server.tool(
    'osiris_get_patterns',
    'Query extracted property patterns. Patterns capture recurring designer preferences.',
    {
      brandId: z.string().optional().describe('Filter by brand'),
      screenType: z.string().optional().describe('Filter by screen type'),
      role: z.string().optional().describe('Filter by SOM role'),
      property: z.string().optional().describe('Filter by property name'),
      status: z.enum(['observed', 'candidate', 'confirmed', 'tombstoned']).optional().describe('Filter by lifecycle status'),
    },
    async ({ brandId, screenType, role, property, status }) => {
      const params = {};
      if (brandId) params.brandId = brandId;
      if (screenType) params.screenType = screenType;
      if (role) params.role = role;
      if (property) params.property = property;
      if (status) params.status = status;
      const patterns = await store.getPatterns(params);
      return textResult({ patterns, count: patterns.length });
    }
  );

  server.tool(
    'osiris_extract_template_patterns',
    'Extract cross-brand designer style patterns from all reference templates.',
    {},
    async () => {
      const templates = await store.listReferenceTemplates({ headsOnly: true, includeSom: true });
      if (templates.length === 0) {
        return textResult({ ok: true, patterns: { upserted: 0, updated: 0, total: 0 }, templateCount: 0 });
      }
      await store.deleteCrossBrandPatterns();
      const patterns = extractPatternsFromTemplates(templates);
      const result = patterns.length > 0
        ? await store.bulkUpsertPatterns(patterns)
        : { upserted: 0, updated: 0, total: 0 };
      return textResult({ ok: true, patterns: result, templateCount: templates.length, extractedCount: patterns.length });
    }
  );

  // ═══ SLICE 8 — Style Guide ═══

  server.tool(
    'osiris_get_style_guide',
    'Get the designer\'s established style guide — typography, spacing, radius, and color principles extracted from refined reference templates.',
    {},
    async () => {
      const guide = await store.getStyleGuide();
      if (!guide) return textResult({ guide: null, message: 'No style guide extracted yet. Call osiris_extract_style_guide first.' });
      if (guide.summary) return { content: [{ type: 'text', text: guide.summary }] };
      return textResult({ guide });
    }
  );

  server.tool(
    'osiris_extract_style_guide',
    'Re-extract the style guide from all reference templates.',
    {},
    async () => {
      const templates = await store.listReferenceTemplates({ headsOnly: true, includeSom: true });
      if (templates.length === 0) {
        return textResult({ ok: true, guide: null, templateCount: 0 });
      }
      const guide = extractStyleGuide(templates);
      await store.saveStyleGuide(guide);
      return textResult({ ok: true, guide, templateCount: templates.length });
    }
  );

  return server;
}

// ─── Express Router Factory ─────────────────────────────────────────────────

export function createMcpRouter(deps) {
  const mcpRouter = express.Router();

  // Track active transports by session ID
  const transports = new Map();

  mcpRouter.post('/', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'];

      if (sessionId && transports.has(sessionId)) {
        // Existing session — reuse transport
        const transport = transports.get(sessionId);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // New session — create fresh MCP server + transport
      const server = createMcpServer(deps);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        },
        onsessionclosed: (id) => {
          transports.delete(id);
        },
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[MCP endpoint] Error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'MCP server error' });
      }
    }
  });

  mcpRouter.get('/', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !transports.has(sessionId)) {
      return res.status(400).json({ error: 'Missing or invalid session ID' });
    }
    const transport = transports.get(sessionId);
    await transport.handleRequest(req, res);
  });

  mcpRouter.delete('/', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !transports.has(sessionId)) {
      return res.status(400).json({ error: 'Missing or invalid session ID' });
    }
    const transport = transports.get(sessionId);
    await transport.handleRequest(req, res);
  });

  return mcpRouter;
}
