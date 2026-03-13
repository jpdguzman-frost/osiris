import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs-extra';
import path from 'path';
import {
  log, logInfo, logSuccess, logWarn, logError, logDim, logProgress,
  CostTracker, resizeForVision, mimeFromExt, sleep, ensureDirs,
  promisePool, PATHS, CLAUDE_MODEL, IMAGE_EXT_RE, parseJsonResponse,
  loadIndustryObjects,
} from './utils.js';

const MODEL = CLAUDE_MODEL;
const MAX_TOKENS = 1500;
const CONCURRENCY = 5;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF = 1000;
const MAX_BACKOFF = 60_000;

let _vocabularies = null;

// ─── Analyzer Class ───────────────────────────────────────────────────────────

export class Analyzer {
  constructor(options = {}) {
    this.client = new Anthropic();
    this.budgetCap = options.budgetCap || parseFloat(process.env.BUDGET_CAP) || 200;
    this.costTracker = new CostTracker(this.budgetCap);
    this.concurrency = options.concurrency || CONCURRENCY;
    this.rubric = null;
  }

  async loadVocabularies() {
    if (!_vocabularies) {
      _vocabularies = await fs.readJson(path.join(PATHS.config, 'vocabularies.json'));
      logDim(`Vocabularies loaded: ${Object.keys(_vocabularies).length} categories`);
    }
    return _vocabularies;
  }

  async loadRubric() {
    if (!this.rubric) {
      this.rubric = await fs.readFile(path.join(PATHS.config, 'rubric.md'), 'utf-8');
      logDim(`Rubric loaded: ${this.rubric.length} chars (~${Math.ceil(this.rubric.length / 4)} tokens)`);
    }
    return this.rubric;
  }

  // ── Main Entry ──────────────────────────────────────────────────────────

  async analyzeAll(industryIds = null, brandPrefixes = null) {
    await this.loadRubric();
    await this.loadVocabularies();

    const industries = await loadIndustryObjects(industryIds);

    logInfo(`Analyzing screens for ${industries.length} industries`);

    const results = {};
    for (const industry of industries) {
      results[industry.id] = await this.analyzeIndustry(industry.id, brandPrefixes);

      // Check budget
      if (this.costTracker.totalCost >= this.budgetCap) {
        logError(`BUDGET EXCEEDED ($${this.costTracker.totalCost.toFixed(2)}). Stopping.`);
        break;
      }
    }

    this.costTracker.print();
    return results;
  }

  async analyzeIndustry(industryId, brandPrefixes = null) {
    const screensDir = path.join(PATHS.screens, industryId);
    const analysisDir = path.join(PATHS.analysis, industryId);
    await ensureDirs(analysisDir);

    if (!await fs.pathExists(screensDir)) {
      logWarn(`No screens directory for ${industryId}`);
      return { analyzed: 0, skipped: 0, errors: 0 };
    }

    // Get all image files, optionally filtered by brand prefix
    const files = (await fs.readdir(screensDir))
      .filter(f => IMAGE_EXT_RE.test(f))
      .filter(f => !brandPrefixes || brandPrefixes.some(p => f.startsWith(p)));

    // Check which are already analyzed (resume support)
    const toAnalyze = [];
    let skipped = 0;
    for (const file of files) {
      const screenId = path.parse(file).name;
      const analysisPath = path.join(analysisDir, `${screenId}.json`);
      if (await fs.pathExists(analysisPath)) {
        skipped++;
      } else {
        toAnalyze.push({ file, screenId });
      }
    }

    logInfo(`\n${industryId}: ${toAnalyze.length} to analyze, ${skipped} already done (${files.length} total)`);

    if (toAnalyze.length === 0) {
      logSuccess(`${industryId}: All screens already analyzed`);
      return { analyzed: 0, skipped, errors: 0 };
    }

    let analyzed = 0;
    let errors = 0;

    // Auto-determine source from industry
    const source = industryId === 'gcash_current' ? 'gcash_current'
      : industryId === 'curated' ? 'curated'
      : 'reference';

    // Process in parallel with concurrency limit
    await promisePool(toAnalyze, this.concurrency, async (item, idx) => {
      // Budget check
      if (this.costTracker.totalCost >= this.budgetCap * 0.95) {
        logWarn('Approaching budget limit, stopping analysis');
        return;
      }

      logProgress(idx + 1, toAnalyze.length, item.screenId.slice(0, 50));

      try {
        const result = await this.analyzeScreen(
          path.join(screensDir, item.file),
          item.screenId,
          industryId,
          source,
        );

        // Save analysis
        const analysisPath = path.join(analysisDir, `${item.screenId}.json`);
        await fs.writeJson(analysisPath, {
          screen_id: item.screenId,
          industry: industryId,
          source,
          file: item.file,
          analyzed_at: new Date().toISOString(),
          ...result,
        }, { spaces: 2 });

        analyzed++;
      } catch (err) {
        logError(`  Failed ${item.screenId}: ${err.message}`);
        errors++;
      }
    });

    logSuccess(`${industryId}: ${analyzed} analyzed, ${errors} errors`);
    return { analyzed, skipped, errors };
  }

  // ── Single Screen Analysis ──────────────────────────────────────────────

  async analyzeScreen(imagePath, screenId, industryId, source = 'reference') {
    const startTime = Date.now();

    // Resize for optimal Vision API input
    const imageBuffer = await resizeForVision(imagePath, 1568);
    const ext = path.extname(imagePath).toLowerCase();
    const mediaType = mimeFromExt(ext);
    const base64 = imageBuffer.toString('base64');

    const userText = `Industry: ${industryId}. Source: ${screenId}. Analyze this screen.`;

    let lastError = null;
    let backoff = INITIAL_BACKOFF;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: [
            {
              type: 'text',
              text: this.rubric,
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

        // Track costs
        const usage = response.usage || {};
        const inputTokens = usage.input_tokens || 0;
        const outputTokens = usage.output_tokens || 0;
        const cachedTokens = usage.cache_read_input_tokens || 0;
        const callCost = this.costTracker.addCall({ inputTokens, outputTokens, cachedTokens });

        const duration = Date.now() - startTime;
        logDim(`  ${screenId}: ${inputTokens}in/${outputTokens}out (${cachedTokens} cached) $${callCost.toFixed(4)} ${duration}ms`);

        // Parse JSON response
        const text = response.content[0]?.text || '';
        const analysis = parseJsonResponse(text);

        // Validate required fields
        if (!analysis.scores || typeof analysis.scores.overall_quality !== 'number') {
          throw new Error('Missing required scores in response');
        }

        // Validate and clamp fingerprint against vocabularies
        if (analysis.fingerprint && _vocabularies) {
          const fp = analysis.fingerprint;
          if (fp.style_tags) {
            fp.style_tags = fp.style_tags.filter(t => _vocabularies.style_tags.includes(t)).slice(0, 4);
          }
          for (const [field, vocabKey] of [
            ['layout_type', 'layout_types'],
            ['design_mood', 'design_moods'],
            ['color_temp', 'color_temps'],
            ['typeface_class', 'typeface_classes'],
          ]) {
            if (fp[field] && !_vocabularies[vocabKey].includes(fp[field])) {
              fp[field] = _vocabularies[vocabKey][0]; // fallback to first
            }
          }
        }

        // Validate screen_type and platform
        if (_vocabularies) {
          if (analysis.screen_type && !_vocabularies.screen_types.includes(analysis.screen_type)) {
            analysis.screen_type = 'home';
          }
          if (analysis.platform && !_vocabularies.platforms.includes(analysis.platform)) {
            analysis.platform = 'unknown';
          }
        }

        return { analysis, source, cost: callCost, duration, tokens: { input: inputTokens, output: outputTokens, cached: cachedTokens } };

      } catch (err) {
        lastError = err;

        // Invalid JSON — retry with correction prompt
        if (err.message === 'Invalid JSON response' && attempt === 0) {
          logWarn(`  ${screenId}: Invalid JSON, retrying with correction prompt`);
          try {
            const retryResponse = await this.client.messages.create({
              model: MODEL,
              max_tokens: MAX_TOKENS,
              system: [
                {
                  type: 'text',
                  text: this.rubric,
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
                {
                  role: 'assistant',
                  content: 'I\'ll analyze this screen now.',
                },
                {
                  role: 'user',
                  content: 'Your output was not valid JSON. Output only the JSON object, no markdown fences.',
                },
              ],
            });

            const usage = retryResponse.usage || {};
            this.costTracker.addCall({
              inputTokens: usage.input_tokens || 0,
              outputTokens: usage.output_tokens || 0,
              cachedTokens: usage.cache_read_input_tokens || 0,
            });

            const retryText = retryResponse.content[0]?.text || '';
            const analysis = parseJsonResponse(retryText);
            return { analysis, cost: 0, duration: Date.now() - startTime, tokens: {} };
          } catch {
            // Fall through to backoff retry
          }
        }

        // Rate limit — backoff
        if (err?.status === 429 || err?.error?.type === 'rate_limit_error') {
          logWarn(`  Rate limited, backing off ${backoff}ms`);
          await sleep(backoff);
          backoff = Math.min(backoff * 2, MAX_BACKOFF);
          continue;
        }

        // Other API errors — backoff and retry
        if (attempt < MAX_RETRIES - 1) {
          logWarn(`  ${screenId}: Attempt ${attempt + 1} failed (${err.message}), retrying in ${backoff}ms`);
          await sleep(backoff);
          backoff = Math.min(backoff * 2, MAX_BACKOFF);
        }
      }
    }

    throw lastError || new Error('Max retries exceeded');
  }

  // ── Cost Estimation ─────────────────────────────────────────────────────

  async estimateCost(industryIds = null) {
    const config = await fs.readJson(path.join(PATHS.config, 'industries.json'));
    const industries = industryIds
      ? config.industries.filter(i => industryIds.includes(i.id))
      : config.industries;

    let totalScreens = 0;
    let alreadyAnalyzed = 0;

    for (const industry of industries) {
      const screensDir = path.join(PATHS.screens, industry.id);
      const analysisDir = path.join(PATHS.analysis, industry.id);

      if (!await fs.pathExists(screensDir)) continue;

      const screens = (await fs.readdir(screensDir))
        .filter(f => IMAGE_EXT_RE.test(f));
      totalScreens += screens.length;

      if (await fs.pathExists(analysisDir)) {
        const analyzed = (await fs.readdir(analysisDir))
          .filter(f => f.endsWith('.json'));
        alreadyAnalyzed += analyzed.length;
      }
    }

    // Also check gcash_current
    const gcashDir = path.join(PATHS.screens, 'gcash_current');
    if (await fs.pathExists(gcashDir)) {
      const gcashScreens = (await fs.readdir(gcashDir))
        .filter(f => IMAGE_EXT_RE.test(f));
      totalScreens += gcashScreens.length;
    }

    const remaining = totalScreens - alreadyAnalyzed;

    // Token estimates per screen (lean rubric)
    const imageTokens = 1600;   // average image tokens
    const rubricTokens = 3000;  // system prompt (cached after first call)
    const outputTokens = 700;   // lean output tokens

    // First call: full rubric cost. Remaining: cached rubric
    const firstCallInput = imageTokens + rubricTokens;
    const cachedCallInput = imageTokens + rubricTokens; // cached portion saves 90%
    const cachedInputCost = (imageTokens / 1_000_000) * 3.0 + (rubricTokens / 1_000_000) * 0.30;
    const firstInputCost = ((imageTokens + rubricTokens) / 1_000_000) * 3.0;
    const outputCostPerCall = (outputTokens / 1_000_000) * 15.0;

    const totalCost = remaining > 0
      ? firstInputCost + outputCostPerCall + (remaining - 1) * (cachedInputCost + outputCostPerCall)
      : 0;

    return {
      totalScreens,
      alreadyAnalyzed,
      remaining,
      estimatedCost: totalCost,
      estimatedPerScreen: remaining > 0 ? totalCost / remaining : 0,
      budgetCap: this.budgetCap,
      budgetPct: ((totalCost / this.budgetCap) * 100).toFixed(1),
    };
  }
}
