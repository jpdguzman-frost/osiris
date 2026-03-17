#!/usr/bin/env node

// Osiris MCP Server — Design Intelligence for Claude
// Translates MCP tool calls into HTTP GETs against the deployed Osiris API.
//
// Transport: stdio (launched by Claude Code)
// API base: https://aux.frostdesigngroup.com/osiris

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_BASE = process.env.OSIRIS_API_BASE || 'https://aux.frostdesigngroup.com/osiris';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const url = new URL(`${API_BASE}${path}`);
  if (options.params) {
    for (const [k, v] of Object.entries(options.params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }
  const fetchOptions = {};
  if (options.body) {
    fetchOptions.method = 'POST';
    fetchOptions.headers = { 'Content-Type': 'application/json' };
    fetchOptions.body = JSON.stringify(options.body);
  }
  if (options.method) fetchOptions.method = options.method;
  const res = await fetch(url.toString(), fetchOptions);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Osiris API ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

function apiGet(path, params = {}) {
  return apiFetch(path, { params });
}

function apiPost(path, body) {
  return apiFetch(path, { body });
}

function textResult(content) {
  return { content: [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content, null, 2) }] };
}

// ─── Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'osiris',
  version: '1.0.0',
});

// ═══════════════════════════════════════════════════════════════════════════
// SLICE 1 — Read Buckets and Insights
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  'osiris_list_buckets',
  'List all curated design buckets in Osiris. Returns bucket names, IDs, screen counts, and whether AI-generated insights exist.',
  {},
  async () => {
    const data = await apiGet('/api/buckets');
    const buckets = (data.buckets || []).map(b => ({
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
    const data = await apiGet(`/api/buckets/${bucket_id}`, { limit: 1 });
    const meta = data.bucket?.metadata || {};
    const result = {
      name: data.bucket?.name,
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
    limit: z.number().min(1).max(48).default(12).describe('Number of screens to return (default 12)'),
    sort: z.string().default('overall_quality').describe('Score field to sort by (default: overall_quality)'),
  },
  async ({ bucket_id, limit, sort }) => {
    const data = await apiGet(`/api/buckets/${bucket_id}`, { sort, order: 'desc', limit });
    const screens = (data.screens || []).map(s => ({
      screen_id: s.screen_id,
      industry: s.industry,
      brand: s.brand || null,
      image_url: s.image_url,
      scores: s.analysis?.scores || {},
      verdict: s.analysis?.verdict || null,
      screen_type: s.analysis?.screen_type || null,
      style_tags: s.fingerprint?.style_tags || [],
      design_mood: s.fingerprint?.design_mood || null,
      layout_type: s.fingerprint?.layout_type || null,
    }));
    return textResult({
      bucket: data.bucket?.name,
      count: screens.length,
      total_in_bucket: data.pagination?.total,
      screens,
    });
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// SLICE 3 — Screen Detail + Scoring Rubric + Benchmarks
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  'osiris_get_screen_detail',
  'Get full analysis for a single screen: all scores, verdict, color palette, typography, spatial layout, fingerprint, and image URL.',
  { screen_id: z.string().describe('Screen ID (from bucket screens or search results)') },
  async ({ screen_id }) => {
    const s = await apiGet(`/api/screens/${screen_id}`);
    return textResult({
      screen_id: s.screen_id,
      industry: s.industry,
      brand: s.brand || null,
      image_url: s.image_url,
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
  'osiris_get_screen_som',
  'Get the cached Screen Object Model (SOM) for a screen — a recursive node tree decomposition with element hierarchy, sizes, spacing, colors, typography, and layout that maps directly to Figma/Rex build instructions. Returns 404 if no SOM has been generated yet. Optionally scales to target dimensions.',
  {
    screen_id: z.string().describe('Screen ID (from bucket screens or search results)'),
    target_width: z.number().optional().describe('Target artboard width in pixels for scaling'),
    target_height: z.number().optional().describe('Target artboard height in pixels for scaling'),
  },
  async ({ screen_id, target_width, target_height }) => {
    const params = {};
    if (target_width) params.target_width = target_width;
    if (target_height) params.target_height = target_height;
    const som = await apiGet(`/api/screens/${screen_id}/som`, params);
    return textResult(som);
  }
);

server.tool(
  'osiris_save_screen_som',
  'Save a Screen Object Model (SOM) to a screen. The SOM is a recursive node tree produced by Claude Code after visually analyzing a screenshot. It is validated and post-processed (grid-snapped, color-fixed) before storage.',
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
    const data = await apiFetch(`/api/screens/${screen_id}/som`, { method: 'PUT', body: som });
    return textResult(data);
  }
);

server.tool(
  'osiris_assign_roles',
  'Assign semantic roles to all nodes in a screen SOM. Auto-detects roles from node names and structure. Returns a role map with confidence scores and flags unknown nodes for AI review.',
  {
    screen_id: z.string().describe('Screen ID with an existing SOM'),
    method: z.enum(['auto', 'ai_assisted']).default('auto').describe('Assignment method'),
    overrides: z.record(z.string()).optional().describe('Manual overrides: { "node-name": "category/role" }'),
  },
  async ({ screen_id, method, overrides }) => {
    const data = await apiPost(`/api/screens/${screen_id}/som/roles`, { method, overrides });
    return textResult(data);
  }
);

server.tool(
  'osiris_merge_som',
  'Merge two SOMs: takes content from one screen and visual style from another. Both screens must have SOMs. Returns a merged SOM ready for Rex to build, plus a detailed merge report.',
  {
    content_som_id: z.string().describe('Screen ID to use as content source'),
    style_som_id: z.string().describe('Screen ID to use as style source'),
    mapping: z.union([
      z.literal('auto'),
      z.record(z.string()),
    ]).default('auto').describe('"auto" for automatic role matching, or a { contentNode: styleNode } map'),
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
    const data = await apiPost('/api/som/merge', { content_som_id, style_som_id, mapping, options });
    return textResult(data);
  }
);

server.tool(
  'osiris_get_scoring_rubric',
  'Get the Osiris scoring rubric — the exact dimensions and scales used to evaluate UI designs. Use this to understand what each score means before self-evaluating.',
  {},
  async () => {
    const res = await fetch(`${API_BASE}/api/rubric`);
    if (!res.ok) return textResult({ error: 'Could not fetch rubric from Osiris API.' });
    const text = await res.text();
    return textResult(text);
  }
);

server.tool(
  'osiris_get_bucket_benchmarks',
  'Get benchmark scores for a bucket: average quality, calm_confident, bold_forward, and other metrics. These are the targets to meet or exceed.',
  { bucket_id: z.string().describe('Bucket ID') },
  async ({ bucket_id }) => {
    const data = await apiGet(`/api/buckets/${bucket_id}`, { limit: 1 });
    const meta = data.bucket?.metadata || {};
    const stats = meta.stats || {};
    return textResult({
      bucket: data.bucket?.name,
      benchmarks: {
        avg_quality: stats.avg_quality ?? null,
        avg_calm_confident: stats.avg_calm ?? null,
        avg_bold_forward: stats.avg_bold ?? null,
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

// ═══════════════════════════════════════════════════════════════════════════
// SLICE 4 — Self-Evaluation Loop
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  'osiris_score_comparison',
  'Compare your self-evaluated design scores against bucket benchmarks. Highlights gaps and identifies areas for iteration. Pass your scores and the benchmark scores.',
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
    }).describe('Your self-evaluated scores for the design'),
    benchmark_scores: z.object({
      avg_quality: z.number().nullable(),
      avg_calm_confident: z.number().nullable(),
      avg_bold_forward: z.number().nullable(),
    }).describe('Benchmark scores from osiris_get_bucket_benchmarks'),
  },
  async ({ design_scores, benchmark_scores }) => {
    const comparisons = [];
    const gaps = [];

    const pairs = [
      ['overall_quality', benchmark_scores.avg_quality, 'Overall Quality'],
      ['calm_confident', benchmark_scores.avg_calm_confident, 'Calm & Confident'],
      ['bold_forward', benchmark_scores.avg_bold_forward, 'Bold & Forward'],
    ];

    for (const [key, benchmark, label] of pairs) {
      const yours = design_scores[key];
      if (yours === undefined || benchmark === null || benchmark === undefined) continue;
      const delta = +(yours - benchmark).toFixed(1);
      const status = delta >= 0 ? 'MEETS' : Math.abs(delta) > 1 ? 'BELOW' : 'CLOSE';
      comparisons.push({ metric: label, yours, benchmark: +benchmark.toFixed(1), delta, status });
      if (status === 'BELOW') gaps.push({ metric: label, gap: Math.abs(delta) });
    }

    // Include extra scores for reference
    const extraScores = {};
    for (const [key, val] of Object.entries(design_scores)) {
      if (!['overall_quality', 'calm_confident', 'bold_forward'].includes(key) && val !== undefined) {
        extraScores[key] = val;
      }
    }

    const needs_iteration = gaps.length > 0;

    return textResult({
      scorecard: comparisons,
      gaps: gaps.length > 0 ? gaps : 'All core metrics meet benchmarks.',
      needs_iteration,
      extra_scores: Object.keys(extraScores).length > 0 ? extraScores : undefined,
      recommendation: needs_iteration
        ? `Focus on: ${gaps.map(g => `${g.metric} (${g.gap}pt below)`).join(', ')}. Iterate on these areas and re-evaluate.`
        : 'Design meets or exceeds all benchmarks. Ready for review.',
    });
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// SLICE 5 — Exploration Tools
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  'osiris_find_similar',
  'Find screens visually and conceptually similar to a given screen across the full Osiris database.',
  {
    screen_id: z.string().describe('Screen ID to find similar screens for'),
    preset: z.enum(['default', 'visual', 'semantic', 'score']).default('default').describe('Similarity weight preset'),
    limit: z.number().min(1).max(50).default(12).describe('Number of results'),
  },
  async ({ screen_id, preset, limit }) => {
    const data = await apiGet(`/api/similar/${screen_id}`, { preset, top: limit });
    const results = (data.results || []).map(r => ({
      screen_id: r.screen_id,
      industry: r.industry,
      brand: r.brand || null,
      image_url: r.image_url,
      similarity_score: r.similarity?.total ?? r.similarity,
      scores: r.analysis?.scores || {},
      verdict: r.analysis?.verdict || null,
      design_mood: r.fingerprint?.design_mood || null,
      style_tags: r.fingerprint?.style_tags || [],
    }));
    return textResult({
      anchor: data.anchor,
      preset: data.preset,
      results,
    });
  }
);

server.tool(
  'osiris_search_screens',
  'Search and filter screens across the full Osiris database by industry, screen type, mood, layout, tags, score range, and sorting.',
  {
    industry: z.string().optional().describe('Filter by industry (e.g. fintech, luxury, automotive)'),
    screen_type: z.string().optional().describe('Filter by screen type (e.g. dashboard, onboarding, home)'),
    mood: z.string().optional().describe('Filter by design mood (e.g. calm, premium, energetic)'),
    layout: z.string().optional().describe('Filter by layout type (e.g. card_grid, dashboard, hero_detail)'),
    brand: z.string().optional().describe('Filter by brand slug (e.g., coinbase, cheval-blanc, nubank). Derived from filename convention brand-name_01.png'),
    tags: z.string().optional().describe('Comma-separated style tags (e.g. minimal,clean,premium)'),
    min_score: z.number().optional().describe('Minimum score for the sort field'),
    sort: z.string().default('overall_quality').describe('Score field to sort by'),
    limit: z.number().min(1).max(48).default(12).describe('Number of results'),
  },
  async ({ industry, screen_type, mood, layout, brand, tags, min_score, sort, limit }) => {
    const data = await apiGet('/api/screens', {
      industry, screen_type, mood, layout, brand, tags, min_score,
      sort, order: 'desc', limit, page: 1,
    });
    const screens = (data.screens || []).map(s => ({
      screen_id: s.screen_id,
      industry: s.industry,
      brand: s.brand || null,
      image_url: s.image_url,
      scores: s.analysis?.scores || {},
      verdict: s.analysis?.verdict || null,
      screen_type: s.analysis?.screen_type || null,
      design_mood: s.fingerprint?.design_mood || null,
      style_tags: s.fingerprint?.style_tags || [],
    }));
    return textResult({
      total: data.pagination?.total,
      showing: screens.length,
      screens,
    });
  }
);

server.tool(
  'osiris_list_brands',
  'List all brands in the Osiris database, optionally filtered by industry. Returns brand slugs, display names, and screen counts.',
  { industry: z.string().optional().describe('Filter brands by industry') },
  async ({ industry }) => {
    const data = await apiGet('/api/brands', { industry });
    return textResult({ brands: data.brands || [] });
  }
);

// ─── Start ──────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
