import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs-extra';
import path from 'path';
import { Store } from './store.js';
import {
  log, logInfo, logSuccess, logWarn, logError, logDim, logProgress,
  CostTracker, resizeForVision, mimeFromExt, sleep, ensureDirs,
  promisePool, PATHS,
} from './utils.js';

const MODEL = 'claude-sonnet-4-5-20250929';
const EXTRACT_MAX_TOKENS = 4096;
const SYNTHESIS_MAX_TOKENS = 8192;
const CONCURRENCY = 2;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF = 5000;
const MAX_BACKOFF = 60_000;

const COMPONENT_CATEGORIES = [
  'navigation', 'card', 'data_viz', 'header', 'input', 'list',
  'button', 'modal', 'balance_display', 'qr_scanner', 'status_indicator',
  'onboarding', 'media_hero', 'icon_system',
];

const EXTRACTION_PROMPT = `You are a UI component analyst extracting discrete UI patterns from app screenshots.

Target emotional territories: CALM & CONFIDENT + BOLD & FORWARD.

## Component Categories
- navigation: Tab bars, bottom nav, side nav, hamburger menus, breadcrumbs
- card: Content cards, stat cards, promotional cards, feature cards
- data_viz: Charts, graphs, gauges, progress indicators, sparklines
- header: Screen headers, hero sections, status bars, section titles
- input: Text fields, amount inputs, search bars, PIN pads, form controls
- list: Transaction lists, settings lists, contact lists, menu lists
- button: Primary CTAs, secondary actions, FABs, icon buttons, toggles
- modal: Bottom sheets, dialogs, confirmation overlays, action sheets
- balance_display: Account balance, wallet amounts, portfolio values
- qr_scanner: QR viewfinders, scan overlays, QR code display
- status_indicator: Status badges, loading states, success/error, pills
- onboarding: Splash, welcome, step indicators, feature tours, empty states
- media_hero: Full-bleed images, product showcases, banners, carousels
- icon_system: Icon grids, service menus, quick-action panels

## Per Component Extract:
- category (from list above)
- subcategory (specific variant, e.g. "bottom_tab_bar", "stat_card_with_sparkline")
- label (short name, e.g. "5-tab bottom nav with dot indicator")
- description (implementation-ready: include colors as hex, font sizes in pt, corner radii, padding, spacing, dimensions, shadow values, icon sizes — everything a designer needs to recreate it)
- bbox: { x, y, w, h } as percentage of image (0-100) — bounding box of this component
- calm_score (1-10): how calm and confident this component feels
- bold_score (1-10): how bold and forward-thinking this component feels
- craft (low | moderate | high | exceptional)

## Also Extract:
- layout_structure: overall screen structure
  - orientation (vertical_scroll | horizontal_scroll | fixed | tabbed)
  - primary_regions (ordered array from top to bottom)
  - grid_system (brief description of layout grid)

## Rules
- Be exhaustive — extract EVERY distinct UI component visible
- Be specific in descriptions — exact measurements, colors, font sizes
- bbox must tightly wrap each component — use percentage coordinates
- Score honestly — reserve 8+ for genuinely excellent craft

Output ONLY valid JSON (no markdown fences):
{
  "components": [
    {
      "category": "",
      "subcategory": "",
      "label": "",
      "description": "",
      "bbox": { "x": 0, "y": 0, "w": 0, "h": 0 },
      "calm_score": 0,
      "bold_score": 0,
      "craft": ""
    }
  ],
  "layout_structure": {
    "orientation": "",
    "primary_regions": [],
    "grid_system": ""
  }
}`;

// ─── PatternExtractor Class ──────────────────────────────────────────────────

export class PatternExtractor {
  constructor(options = {}) {
    this.client = new Anthropic();
    this.store = new Store();
    this.budgetCap = options.budgetCap || parseFloat(process.env.BUDGET_CAP) || 200;
    this.costTracker = new CostTracker(this.budgetCap);
  }

  // ── Main Entry ──────────────────────────────────────────────────────────

  async run(industryIds = null) {
    // Phase 1: Per-screen extraction
    await this.extractAll(industryIds);

    // Phase 2: Crop components using bbox
    await this.cropComponents(industryIds);

    // Phase 3: Ingest to MongoDB
    await this.ingestToMongo(industryIds);

    // Phase 4: HTML output
    await this.generatePatternLibraryHtml();

    this.costTracker.print();
  }

  // ── Phase 1: Per-Screen Extraction ────────────────────────────────────

  async extractAll(industryIds = null) {
    const config = await fs.readJson(path.join(PATHS.config, 'industries.json'));
    const industries = industryIds
      ? config.industries.filter(i => industryIds.includes(i.id))
      : config.industries;

    // Include special folders if they exist
    for (const special of [
      { id: 'gcash_current', name: 'GCash Current State' },
      { id: 'curated', name: 'Curated References' },
    ]) {
      const dir = path.join(PATHS.screens, special.id);
      if (await fs.pathExists(dir) && (!industryIds || industryIds.includes(special.id))) {
        if (!industries.find(i => i.id === special.id)) {
          industries.push(special);
        }
      }
    }

    logInfo(`Extracting component patterns for ${industries.length} industries`);

    const results = {};
    for (const industry of industries) {
      results[industry.id] = await this.extractIndustry(industry.id);

      if (this.costTracker.totalCost >= this.budgetCap) {
        logError(`BUDGET EXCEEDED ($${this.costTracker.totalCost.toFixed(2)}). Stopping.`);
        break;
      }
    }

    return results;
  }

  async extractIndustry(industryId) {
    const screensDir = path.join(PATHS.screens, industryId);
    const patternsDir = path.join(PATHS.patterns, industryId);
    await ensureDirs(patternsDir);

    if (!await fs.pathExists(screensDir)) {
      logWarn(`No screens directory for ${industryId}`);
      return { extracted: 0, skipped: 0, errors: 0 };
    }

    const files = (await fs.readdir(screensDir))
      .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f));

    // Resume support
    const toExtract = [];
    let skipped = 0;
    for (const file of files) {
      const screenId = path.parse(file).name;
      const patternPath = path.join(patternsDir, `${screenId}.json`);
      if (await fs.pathExists(patternPath)) {
        skipped++;
      } else {
        toExtract.push({ file, screenId });
      }
    }

    logInfo(`\n${industryId}: ${toExtract.length} to extract, ${skipped} already done (${files.length} total)`);

    if (toExtract.length === 0) {
      logSuccess(`${industryId}: All screens already extracted`);
      return { extracted: 0, skipped, errors: 0 };
    }

    let extracted = 0;
    let errors = 0;

    await promisePool(toExtract, CONCURRENCY, async (item, idx) => {
      if (this.costTracker.totalCost >= this.budgetCap * 0.95) {
        logWarn('Approaching budget limit, stopping extraction');
        return;
      }

      logProgress(idx + 1, toExtract.length, item.screenId.slice(0, 50));

      try {
        const result = await this.extractScreen(
          path.join(screensDir, item.file),
          item.screenId,
          industryId,
        );

        // Assign component IDs
        if (result.extraction?.components) {
          result.extraction.components.forEach((comp, i) => {
            comp.component_id = `${item.screenId}__${comp.category}_${String(i).padStart(2, '0')}`;
          });
        }

        const patternPath = path.join(patternsDir, `${item.screenId}.json`);
        await fs.writeJson(patternPath, {
          screen_id: item.screenId,
          industry: industryId,
          file: item.file,
          extracted_at: new Date().toISOString(),
          component_count: result.extraction?.components?.length || 0,
          ...result,
        }, { spaces: 2 });

        extracted++;
      } catch (err) {
        logError(`  Failed ${item.screenId}: ${err.message}`);
        errors++;
      }
    });

    logSuccess(`${industryId}: ${extracted} extracted, ${errors} errors`);
    return { extracted, skipped, errors };
  }

  async extractScreen(imagePath, screenId, industryId) {
    const startTime = Date.now();

    const imageBuffer = await resizeForVision(imagePath, 1568);
    const ext = path.extname(imagePath).toLowerCase();
    const mediaType = mimeFromExt(ext);
    const base64 = imageBuffer.toString('base64');

    const userText = `Industry: ${industryId}. Source: ${screenId}. Extract all UI component patterns from this screen.`;

    let lastError = null;
    let backoff = INITIAL_BACKOFF;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: MODEL,
          max_tokens: EXTRACT_MAX_TOKENS,
          system: [
            {
              type: 'text',
              text: EXTRACTION_PROMPT,
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: mediaType, data: base64 },
                },
                {
                  type: 'text',
                  text: userText,
                },
              ],
            },
          ],
        });

        const usage = response.usage || {};
        const inputTokens = usage.input_tokens || 0;
        const outputTokens = usage.output_tokens || 0;
        const cachedTokens = usage.cache_read_input_tokens || 0;
        const callCost = this.costTracker.addCall({ inputTokens, outputTokens, cachedTokens });

        const duration = Date.now() - startTime;
        logDim(`  ${screenId}: ${inputTokens}in/${outputTokens}out (${cachedTokens} cached) $${callCost.toFixed(4)} ${duration}ms`);

        const text = response.content[0]?.text || '';
        let extraction;
        try {
          extraction = JSON.parse(text);
        } catch {
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            extraction = JSON.parse(jsonMatch[0]);
          } else {
            throw new Error('Invalid JSON response');
          }
        }

        if (!extraction.components || !Array.isArray(extraction.components)) {
          throw new Error('Missing components array in response');
        }

        return {
          extraction,
          cost: callCost,
          duration,
          tokens: { input: inputTokens, output: outputTokens, cached: cachedTokens },
        };

      } catch (err) {
        lastError = err;

        if (err.message === 'Invalid JSON response' && attempt === 0) {
          logWarn(`  ${screenId}: Invalid JSON, retrying with correction prompt`);
          continue;
        }

        if (err?.status === 429 || err?.error?.type === 'rate_limit_error') {
          logWarn(`  Rate limited, backing off ${backoff}ms`);
          await sleep(backoff);
          backoff = Math.min(backoff * 2, MAX_BACKOFF);
          continue;
        }

        if (attempt < MAX_RETRIES - 1) {
          logWarn(`  ${screenId}: Attempt ${attempt + 1} failed (${err.message}), retrying in ${backoff}ms`);
          await sleep(backoff);
          backoff = Math.min(backoff * 2, MAX_BACKOFF);
        }
      }
    }

    throw lastError || new Error('Max retries exceeded');
  }

  // ── Phase 2: Crop Components ────────────────────────────────────────

  async cropComponents(industryIds = null) {
    const sharp = (await import('sharp')).default;
    const cropBase = path.join(PATHS.data, 'patterns', 'crops');

    const config = await fs.readJson(path.join(PATHS.config, 'industries.json'));
    let industries = config.industries.map(i => i.id);

    // Include special folders
    for (const special of ['gcash_current', 'curated']) {
      if (await fs.pathExists(path.join(PATHS.patterns, special))) {
        if (!industries.includes(special)) industries.push(special);
      }
    }

    if (industryIds) {
      industries = industries.filter(id => industryIds.includes(id));
    }

    let totalCropped = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    for (const industryId of industries) {
      const patternsDir = path.join(PATHS.patterns, industryId);
      if (!await fs.pathExists(patternsDir)) continue;

      const cropDir = path.join(cropBase, industryId);
      await ensureDirs(cropDir);

      const files = (await fs.readdir(patternsDir)).filter(f => f.endsWith('.json'));
      logInfo(`Cropping ${industryId}: ${files.length} screens`);

      for (const file of files) {
        try {
          const data = await fs.readJson(path.join(patternsDir, file));
          const components = data.extraction?.components || [];
          const imageFile = data.file;
          if (!imageFile) continue;

          const imagePath = path.join(PATHS.screens, industryId, imageFile);
          if (!await fs.pathExists(imagePath)) continue;

          const meta = await sharp(imagePath).metadata();
          const imgW = meta.width;
          const imgH = meta.height;

          for (let i = 0; i < components.length; i++) {
            const comp = components[i];
            const compId = comp.component_id || `${data.screen_id}__${comp.category}_${String(i).padStart(2, '0')}`;
            const cropPath = path.join(cropDir, `${compId}.png`);

            // Skip if already cropped
            if (await fs.pathExists(cropPath)) {
              totalSkipped++;
              continue;
            }

            const bbox = comp.bbox;
            if (!bbox || !bbox.w || !bbox.h) {
              totalSkipped++;
              continue;
            }

            // bbox values could be percentages (0-100) or pixels
            // Detect: if all values are <= 100 and image is large, treat as percentages
            const isPercentage = bbox.x <= 100 && bbox.y <= 100 && bbox.w <= 100 && bbox.h <= 100 && imgW > 200;
            let x, y, w, h;
            if (isPercentage) {
              x = Math.round((bbox.x / 100) * imgW);
              y = Math.round((bbox.y / 100) * imgH);
              w = Math.round((bbox.w / 100) * imgW);
              h = Math.round((bbox.h / 100) * imgH);
            } else {
              x = Math.round(bbox.x);
              y = Math.round(bbox.y);
              w = Math.round(bbox.w);
              h = Math.round(bbox.h);
            }

            // Clamp to image bounds
            x = Math.max(0, Math.min(x, imgW - 1));
            y = Math.max(0, Math.min(y, imgH - 1));
            w = Math.max(10, Math.min(w, imgW - x));
            h = Math.max(10, Math.min(h, imgH - y));

            try {
              await sharp(imagePath)
                .extract({ left: x, top: y, width: w, height: h })
                .png()
                .toFile(cropPath);
              totalCropped++;
            } catch (err) {
              logError(`  Crop failed ${compId}: ${err.message}`);
              totalErrors++;
            }
          }
        } catch (err) {
          logError(`  Failed ${file}: ${err.message}`);
          totalErrors++;
        }
      }
    }

    logSuccess(`Cropped ${totalCropped} components (${totalSkipped} skipped, ${totalErrors} errors)`);
  }

  // ── Phase 2b: Pattern Synthesis (run separately) ───────────────────────

  async synthesizePatterns() {
    logInfo('Starting pattern synthesis');

    // Load all extracted patterns
    const allComponents = await this.loadAllExtractedPatterns();
    logInfo(`Loaded ${allComponents.length} components across all screens`);

    if (allComponents.length === 0) {
      logWarn('No extracted patterns found. Run extraction first.');
      return;
    }

    await ensureDirs(PATHS.synthesis);

    // Group by category
    const byCategory = {};
    for (const comp of allComponents) {
      const cat = comp.category;
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(comp);
    }

    logInfo(`Categories found: ${Object.keys(byCategory).join(', ')}`);

    // Synthesize each category
    const allClusters = [];
    for (const [category, components] of Object.entries(byCategory)) {
      if (components.length < 2) {
        logDim(`  Skipping ${category} — only ${components.length} component(s)`);
        continue;
      }

      logInfo(`  Clustering: ${category} (${components.length} components)`);
      const clusters = await this.synthesizeCategory(category, components);
      if (clusters && clusters.length > 0) {
        allClusters.push(...clusters);
      }
    }

    // Cross-category synthesis
    logInfo('  Synthesizing cross-category patterns');
    const crossCategory = await this.synthesizeCrossCategory(allClusters, byCategory);

    // Save results
    await fs.writeJson(
      path.join(PATHS.synthesis, 'pattern_clusters.json'),
      allClusters,
      { spaces: 2 },
    );
    await fs.writeJson(
      path.join(PATHS.synthesis, 'pattern_library_summary.json'),
      crossCategory,
      { spaces: 2 },
    );

    // Ingest to MongoDB
    await this.ingestToMongo(allComponents, allClusters, crossCategory);

    logSuccess(`Synthesis complete: ${allClusters.length} pattern clusters identified`);
    return { clusters: allClusters, summary: crossCategory };
  }

  async loadAllExtractedPatterns(industryIds = null) {
    const allComponents = [];

    const config = await fs.readJson(path.join(PATHS.config, 'industries.json'));
    let industries = config.industries.map(i => i.id);

    // Include special folders
    for (const special of ['gcash_current', 'curated']) {
      if (await fs.pathExists(path.join(PATHS.patterns, special))) {
        if (!industries.includes(special)) industries.push(special);
      }
    }

    if (industryIds) {
      industries = industries.filter(id => industryIds.includes(id));
    }

    for (const industryId of industries) {
      const patternsDir = path.join(PATHS.patterns, industryId);
      if (!await fs.pathExists(patternsDir)) continue;

      const files = (await fs.readdir(patternsDir)).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const data = await fs.readJson(path.join(patternsDir, file));
          const components = data.extraction?.components || [];
          for (const comp of components) {
            allComponents.push({
              ...comp,
              screen_id: data.screen_id,
              industry: data.industry,
              file: data.file,
            });
          }
        } catch {}
      }
    }

    return allComponents;
  }

  async synthesizeCategory(category, components) {
    // Sort by quality, take top 100 to stay within context
    const sorted = components
      .sort((a, b) => {
        const aScore = (a.calm_score || a.design_qualities?.calm_confident_score || 0) + (a.bold_score || a.design_qualities?.bold_forward_score || 0);
        const bScore = (b.calm_score || b.design_qualities?.calm_confident_score || 0) + (b.bold_score || b.design_qualities?.bold_forward_score || 0);
        return bScore - aScore;
      })
      .slice(0, 100);

    const dataSummary = sorted.map(c => ({
      component_id: c.component_id,
      screen_id: c.screen_id,
      industry: c.industry,
      subcategory: c.subcategory,
      label: c.label,
      description: c.description,
      calm_score: c.calm_score || c.design_qualities?.calm_confident_score || 0,
      bold_score: c.bold_score || c.design_qualities?.bold_forward_score || 0,
      craft: c.craft || c.design_qualities?.craft_level || '',
    }));

    const prompt = `You are clustering UI component patterns for a fintech super-app redesign (GCash, 94M users).
Target: CALM & CONFIDENT + BOLD & FORWARD.

CATEGORY: ${category.toUpperCase()}
Total components: ${components.length} (showing top ${sorted.length} by quality)

Components:
${JSON.stringify(dataSummary, null, 2)}

Identify distinct PATTERN CLUSTERS within this category. Group components that share the same structural approach (even if from different industries).

For each cluster:
1. Name it descriptively (e.g., "minimal_icon_only_bottom_nav", "stat_card_with_sparkline")
2. Count how many components belong to it
3. List which industries it appears in
4. Pick the best exemplar (highest quality instance)
5. Describe its design signature (key visual traits, color, spacing, typography)
6. Rate its applicability to GCash with implementation guidance

Output as JSON:
{
  "clusters": [
    {
      "cluster_id": "${category}__cluster_name",
      "category": "${category}",
      "pattern_name": "Human-readable name",
      "pattern_description": "What defines this pattern",
      "occurrence_count": 0,
      "industry_spread": [],
      "exemplar_components": [{ "component_id": "", "screen_id": "", "industry": "", "quality_note": "" }],
      "best_exemplar_id": "component_id of best instance",
      "avg_calm_confident": 0,
      "avg_bold_forward": 0,
      "design_signature": {
        "key_visual_traits": [],
        "color_approach": "",
        "spacing_approach": "",
        "typography_approach": ""
      },
      "gcash_recommendation": {
        "applicable_screens": [],
        "implementation_guidance": "",
        "priority": "critical|high|medium|low",
        "adaptation_notes": ""
      },
      "cross_industry_insight": ""
    }
  ]
}`;

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: SYNTHESIS_MAX_TOKENS,
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
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
      return parsed.clusters || [];
    } catch {
      logError(`  Failed to parse ${category} synthesis`);
      return [];
    }
  }

  async synthesizeCrossCategory(allClusters, byCategory) {
    const categorySummary = Object.entries(byCategory).map(([cat, comps]) => ({
      category: cat,
      count: comps.length,
      industries: [...new Set(comps.map(c => c.industry))],
    }));

    const clusterSummary = allClusters.map(c => ({
      cluster_id: c.cluster_id,
      category: c.category,
      pattern_name: c.pattern_name,
      occurrence_count: c.occurrence_count,
      industry_spread: c.industry_spread,
      avg_calm_confident: c.avg_calm_confident,
      avg_bold_forward: c.avg_bold_forward,
      priority: c.gcash_recommendation?.priority,
    }));

    const prompt = `You are the lead design strategist creating a component pattern library for GCash — the Philippines' #1 fintech super-app (94M users).
Target: CALM & CONFIDENT + BOLD & FORWARD.

## Component Categories Found:
${JSON.stringify(categorySummary, null, 2)}

## All Pattern Clusters:
${JSON.stringify(clusterSummary, null, 2)}

Synthesize a cross-category overview:

1. **Dominant structural patterns**: What layout/component combinations create the strongest screens?
2. **Design system coherence**: Which component styles work together as a unified system?
3. **Priority component library**: The top 15 patterns GCash should implement first, ranked by impact
4. **Component relationships**: How should navigation, cards, headers, and data_viz work together?
5. **Industry fusion**: Which industries contribute the strongest patterns per category?
6. **Anti-patterns**: Component approaches to explicitly avoid

Output as JSON:
{
  "dominant_structural_patterns": [{ "pattern": "", "component_combination": [], "why_effective": "" }],
  "design_system_coherence": { "recommended_style_family": "", "unifying_traits": [], "tension_points": [] },
  "priority_library": [{ "rank": 1, "cluster_id": "", "pattern_name": "", "category": "", "impact": "", "effort": "small|medium|large" }],
  "component_relationships": { "navigation_to_content": "", "header_to_body": "", "cards_to_lists": "", "data_viz_to_context": "" },
  "industry_fusion": {},
  "anti_patterns": [{ "pattern": "", "why_avoid": "" }],
  "meta_insight": ""
}`;

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: SYNTHESIS_MAX_TOKENS,
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
      logError('Failed to parse cross-category synthesis');
      return { raw: text };
    }
  }

  // ── MongoDB Ingestion ─────────────────────────────────────────────────

  async ingestToMongo(industryIds = null) {
    const allComponents = await this.loadAllExtractedPatterns(industryIds);
    if (allComponents.length === 0) {
      logWarn('No components to ingest');
      return;
    }

    await this.store.connect();

    const componentsColl = this.store.db.collection('component_patterns');
    let ingested = 0;
    for (const comp of allComponents) {
      try {
        await componentsColl.updateOne(
          { component_id: comp.component_id },
          {
            $set: {
              ...comp,
              created_at: new Date(),
            },
          },
          { upsert: true },
        );
        ingested++;
      } catch (err) {
        if (err.code !== 11000) {
          logError(`Failed to ingest component ${comp.component_id}: ${err.message}`);
        }
      }
    }
    logSuccess(`Ingested ${ingested} components to MongoDB`);

    await this.store.close();
  }

  // ── Phase 3: HTML Pattern Library ─────────────────────────────────────

  async generatePatternLibraryHtml() {
    await ensureDirs(PATHS.outputPatternLibrary);

    // Load data
    const allComponents = await this.loadAllExtractedPatterns();

    // Build image path + crop path map for components
    const cropsBase = path.join(PATHS.patterns, 'crops');
    const componentData = [];
    for (const c of allComponents) {
      const screensDir = path.join(PATHS.screens, c.industry);
      const imagePath = c.file
        ? path.relative(PATHS.outputPatternLibrary, path.join(screensDir, c.file))
        : null;

      // Check for cropped image
      let cropPath = null;
      if (c.component_id) {
        const cropFile = path.join(cropsBase, c.industry, `${c.component_id}.png`);
        if (await fs.pathExists(cropFile)) {
          cropPath = path.relative(PATHS.outputPatternLibrary, cropFile);
        }
      }

      componentData.push({ ...c, image_path: imagePath, crop_path: cropPath });
    }

    logInfo(`Building pattern library: ${componentData.length} components`);

    const html = this.buildPatternHtml(componentData);
    await fs.writeFile(path.join(PATHS.outputPatternLibrary, 'index.html'), html);

    logSuccess(`Pattern library saved: ${path.join(PATHS.outputPatternLibrary, 'index.html')}`);
  }

  buildPatternHtml(components) {
    const categories = [...new Set(components.map(c => c.category))].sort();
    const industries = [...new Set(components.map(c => c.industry))].sort();

    const componentsJson = JSON.stringify(components);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GCash Intelligence — Component Pattern Library</title>
<style>
  :root {
    --bg: #0a0a0b;
    --surface: #141416;
    --surface-hover: #1a1a1e;
    --border: #2a2a2e;
    --text: #e4e4e7;
    --text-dim: #71717a;
    --accent: #6366f1;
    --calm: #38bdf8;
    --bold: #f472b6;
  }
  html { font-size: clamp(14px, 0.45vw + 12px, 18px); }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: var(--bg); color: var(--text); line-height: 1.5;
  }

  .header {
    padding: 2rem 2rem 1rem;
    border-bottom: 1px solid var(--border);
    position: sticky; top: 0; background: var(--bg); z-index: 100;
  }
  .header h1 { font-size: 1.5rem; font-weight: 600; letter-spacing: -0.02em; }
  .header .subtitle { color: var(--text-dim); font-size: 0.875rem; margin-top: 0.25rem; }
  .stats { display: flex; gap: 2rem; margin-top: 1rem; font-size: 0.8rem; color: var(--text-dim); }
  .stats span { color: var(--text); font-weight: 600; }

  .controls {
    padding: 1rem 2rem;
    display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center;
    border-bottom: 1px solid var(--border);
    position: sticky; top: 90px; background: var(--bg); z-index: 99;
  }
  .tab {
    padding: 0.375rem 0.75rem; border-radius: 6px; border: 1px solid var(--border);
    background: transparent; color: var(--text-dim); cursor: pointer; font-size: 0.75rem;
    transition: all 0.15s;
  }
  .tab:hover { border-color: var(--text-dim); color: var(--text); }
  .tab.active { background: var(--accent); border-color: var(--accent); color: white; }
  .tab-group { display: flex; gap: 0.25rem; flex-wrap: wrap; }
  .tab-group-label { font-size: 0.7rem; color: var(--text-dim); margin-right: 0.5rem; align-self: center; }
  .separator { width: 1px; height: 24px; background: var(--border); margin: 0 0.5rem; }
  .sort-select {
    padding: 0.375rem 0.5rem; border-radius: 6px; border: 1px solid var(--border);
    background: var(--surface); color: var(--text-dim); font-size: 0.75rem; cursor: pointer;
  }

  .count { padding: 0.5rem 2rem; font-size: 0.8rem; color: var(--text-dim); }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 1rem; padding: 1.5rem 2rem;
  }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 10px; overflow: hidden; cursor: pointer;
    transition: border-color 0.15s, transform 0.15s;
  }
  .card:hover { border-color: var(--accent); transform: translateY(-2px); }
  .card-img {
    width: 100%; height: 160px; object-fit: cover; object-position: top;
    background: #000; display: block;
  }
  .card-body { padding: 0.75rem; }
  .card-label { font-size: 0.8rem; font-weight: 600; margin-bottom: 0.25rem;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card-meta { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 0.4rem; }
  .badge {
    font-size: 0.6rem; padding: 0.1rem 0.35rem; border-radius: 4px; font-weight: 600;
  }
  .badge-cat { background: rgba(99,102,241,0.15); color: var(--accent); }
  .badge-ind { background: rgba(113,113,122,0.1); color: var(--text-dim); }
  .badge-craft { background: rgba(34,197,94,0.15); color: #22c55e; }
  .card-scores { display: flex; gap: 0.5rem; }
  .score-pill {
    font-size: 0.65rem; padding: 0.15rem 0.4rem; border-radius: 8px;
    font-weight: 600; font-variant-numeric: tabular-nums;
  }
  .score-calm { background: rgba(56,189,248,0.15); color: var(--calm); }
  .score-bold { background: rgba(244,114,182,0.15); color: var(--bold); }

  .no-results { padding: 4rem 2rem; text-align: center; color: var(--text-dim); }

  .detail-overlay {
    display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.8);
    z-index: 200; overflow-y: auto; padding: 2rem;
  }
  .detail-overlay.open { display: block; }
  .detail-panel {
    max-width: 800px; margin: 0 auto; background: var(--surface);
    border-radius: 12px; border: 1px solid var(--border); overflow: hidden;
  }
  .detail-panel .content { padding: 1.5rem; }
  .detail-panel .close-btn {
    position: absolute; top: 1rem; right: 1rem;
    background: var(--surface); border: 1px solid var(--border); color: var(--text);
    padding: 0.375rem 0.75rem; border-radius: 6px; cursor: pointer; font-size: 0.8rem;
  }
</style>
</head>
<body>
<div class="header">
  <h1>GCash Intelligence — Component Pattern Library</h1>
  <p class="subtitle">Cross-industry UI component patterns for the GCash visual redesign</p>
  <div class="stats">
    <div><span id="stat-components">0</span> components</div>
    <div><span id="stat-categories">0</span> categories</div>
    <div><span id="stat-industries">0</span> industries</div>
  </div>
</div>

<div class="controls">
  <span class="tab-group-label">Category:</span>
  <div class="tab-group" id="category-tabs">
    <button class="tab active" data-category="all">All</button>
  </div>
  <div class="separator"></div>
  <span class="tab-group-label">Industry:</span>
  <div class="tab-group" id="industry-tabs">
    <button class="tab active" data-industry="all">All</button>
  </div>
  <div class="separator"></div>
  <span class="tab-group-label">Sort:</span>
  <select class="sort-select" id="sort-select">
    <option value="category">Category</option>
    <option value="calm_desc">Calm (high first)</option>
    <option value="bold_desc">Bold (high first)</option>
    <option value="craft">Craft level</option>
    <option value="screen">Screen</option>
  </select>
</div>

<div class="count" id="count"></div>
<div class="grid" id="grid"></div>

<div class="detail-overlay" id="detail">
  <div class="detail-panel" id="detail-panel"></div>
</div>

<script>
const COMPONENTS = ${componentsJson};
let currentCategory = 'all';
let currentIndustry = 'all';
let currentSort = 'category';

const categories = [...new Set(COMPONENTS.map(c => c.category))].sort();
const industries = [...new Set(COMPONENTS.map(c => c.industry))].sort();
const craftOrder = { exceptional: 0, high: 1, moderate: 2, low: 3 };

const catTabs = document.getElementById('category-tabs');
categories.forEach(cat => {
  const btn = document.createElement('button');
  btn.className = 'tab';
  btn.dataset.category = cat;
  btn.textContent = cat.replace(/_/g, ' ');
  catTabs.appendChild(btn);
});

const indTabs = document.getElementById('industry-tabs');
industries.forEach(ind => {
  const btn = document.createElement('button');
  btn.className = 'tab';
  btn.dataset.industry = ind;
  btn.textContent = ind;
  indTabs.appendChild(btn);
});

document.getElementById('stat-components').textContent = COMPONENTS.length;
document.getElementById('stat-categories').textContent = categories.length;
document.getElementById('stat-industries').textContent = industries.length;

function getFiltered() {
  let filtered = COMPONENTS.filter(c => {
    if (currentCategory !== 'all' && c.category !== currentCategory) return false;
    if (currentIndustry !== 'all' && c.industry !== currentIndustry) return false;
    return true;
  });
  if (currentSort === 'calm_desc') filtered.sort((a, b) => (b.calm_score || 0) - (a.calm_score || 0));
  else if (currentSort === 'bold_desc') filtered.sort((a, b) => (b.bold_score || 0) - (a.bold_score || 0));
  else if (currentSort === 'craft') filtered.sort((a, b) => (craftOrder[a.craft] ?? 9) - (craftOrder[b.craft] ?? 9));
  else if (currentSort === 'screen') filtered.sort((a, b) => (a.screen_id || '').localeCompare(b.screen_id || ''));
  else filtered.sort((a, b) => (a.category || '').localeCompare(b.category || ''));
  return filtered;
}

function render() {
  const filtered = getFiltered();
  document.getElementById('count').textContent = filtered.length + ' components shown';
  const container = document.getElementById('grid');

  if (filtered.length === 0) {
    container.innerHTML = '<div class="no-results">No components match the current filters</div>';
    return;
  }

  container.innerHTML = filtered.map((c, i) => {
    const src = c.crop_path || c.image_path || '';
    const img = src
      ? '<img class="card-img" src="' + src + '" loading="lazy" onerror="this.style.display=\\'none\\'">'
      : '<div class="card-img" style="display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:0.75rem">No image</div>';
    return '<div class="card" data-idx="' + i + '">' +
      img +
      '<div class="card-body">' +
      '<div class="card-label">' + (c.label || c.subcategory || 'Component') + '</div>' +
      '<div class="card-meta">' +
      '<span class="badge badge-cat">' + (c.category || '') + '</span>' +
      '<span class="badge badge-ind">' + (c.industry || '') + '</span>' +
      (c.craft ? '<span class="badge badge-craft">' + c.craft + '</span>' : '') +
      '</div>' +
      '<div class="card-scores">' +
      '<span class="score-pill score-calm">CC ' + (c.calm_score || '-') + '</span>' +
      '<span class="score-pill score-bold">BF ' + (c.bold_score || '-') + '</span>' +
      '</div>' +
      '</div></div>';
  }).join('');

  container.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', () => {
      const idx = parseInt(card.dataset.idx);
      openDetail(filtered[idx]);
    });
  });
}

function openDetail(comp) {
  if (!comp) return;
  const calmScore = comp.calm_score || '-';
  const boldScore = comp.bold_score || '-';

  let imgHtml = '';
  const cropSrc = comp.crop_path || '';
  if (cropSrc) {
    imgHtml = '<div style="width:100%;border-radius:8px;background:var(--bg);margin-bottom:1rem;overflow:hidden">' +
      '<img src="' + cropSrc + '" style="width:100%;height:auto;display:block" loading="lazy" onerror="this.parentElement.style.display=\\'none\\'">' +
      '</div>';
  } else if (comp.image_path) {
    imgHtml = '<div style="width:100%;height:300px;overflow:hidden;border-radius:8px;background:var(--bg);margin-bottom:1rem">' +
      '<img src="' + comp.image_path + '" style="width:100%;height:100%;object-fit:cover;object-position:center" loading="lazy" onerror="this.parentElement.style.display=\\'none\\'">' +
      '</div>';
  }

  const html = '<div class="content">' +
    '<button class="close-btn" onclick="closeDetail()">Close</button>' +
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.75rem">' +
    '<div>' +
    '<h3 style="margin:0 0 0.25rem 0">' + (comp.label || comp.subcategory || 'Component') + '</h3>' +
    '<div style="display:flex;gap:0.4rem;flex-wrap:wrap">' +
    '<span class="badge badge-cat">' + (comp.category || '') + '</span>' +
    (comp.subcategory ? '<span class="badge badge-ind">' + comp.subcategory + '</span>' : '') +
    '<span class="badge badge-ind">' + (comp.industry || '') + '</span>' +
    (comp.craft ? '<span class="badge badge-craft">' + comp.craft + '</span>' : '') +
    '</div></div>' +
    '<div style="display:flex;gap:0.5rem;flex-shrink:0">' +
    '<span class="score-pill score-calm">CC ' + calmScore + '</span>' +
    '<span class="score-pill score-bold">BF ' + boldScore + '</span>' +
    '</div></div>' +
    imgHtml +
    '<p style="font-size:0.85rem;color:var(--text-dim);margin:0.5rem 0">' + (comp.description || '') + '</p>' +
    '<div style="font-size:0.7rem;color:var(--text-dim);margin-top:0.75rem;padding-top:0.5rem;border-top:1px solid var(--border)">' +
    'Screen: ' + (comp.screen_id || '') + '</div></div>';

  document.getElementById('detail-panel').innerHTML = html;
  document.getElementById('detail').classList.add('open');
}

function closeDetail() {
  document.getElementById('detail').classList.remove('open');
}

document.querySelectorAll('#category-tabs .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#category-tabs .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentCategory = tab.dataset.category;
    render();
  });
});
document.querySelectorAll('#industry-tabs .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#industry-tabs .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentIndustry = tab.dataset.industry;
    render();
  });
});
document.getElementById('sort-select').addEventListener('change', e => {
  currentSort = e.target.value;
  render();
});

document.getElementById('detail').addEventListener('click', e => {
  if (e.target.id === 'detail') closeDetail();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeDetail();
});

render();
</script>
</body>
</html>`;
  }
}
