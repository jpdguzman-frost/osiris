#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config({ override: true });
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs-extra';
import path from 'path';
import sharp from 'sharp';
import {
  logInfo, logSuccess, logWarn, logError, logDim, logProgress,
  CostTracker, resizeForVision, mimeFromExt, sleep, ensureDirs,
  promisePool, PATHS, parseFlags, loadIndustries, parseJsonResponse, CLAUDE_MODEL,
} from '../src/utils.js';

const MODEL = CLAUDE_MODEL;
const MAX_TOKENS = 4096;
const CONCURRENCY = 2;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF = 5000;
const MAX_BACKOFF = 60_000;
const CROP_DIR = path.join(PATHS.patterns, 'crops');

const { flags, industryFilter } = parseFlags();
const cropOnly = flags['crop-only'] === true;

// ─── Main ─────────────────────────────────────────────────────────────────────

const client = new Anthropic();
const costTracker = new CostTracker(parseFloat(process.env.BUDGET_CAP) || 200);

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   GCash Intelligence — Bounding Box Extractor            ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  if (!cropOnly && !process.env.ANTHROPIC_API_KEY) {
    logError('ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }

  const industries = await loadIndustries(industryFilter, PATHS.patterns);

  if (cropOnly) {
    logInfo('Crop-only mode: generating crops from existing bounding boxes');
    for (const industryId of industries) {
      await cropFromBboxes(industryId);
    }
    logSuccess('Cropping complete');
    return;
  }

  let totalProcessed = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const industryId of industries) {
    const patternsDir = path.join(PATHS.patterns, industryId);
    if (!await fs.pathExists(patternsDir)) continue;

    const files = (await fs.readdir(patternsDir)).filter(f => f.endsWith('.json'));
    logInfo(`${industryId}: ${files.length} screens to process`);

    await promisePool(files, CONCURRENCY, async (file, idx) => {
      logProgress(idx + 1, files.length, file.slice(0, 40));

      try {
        const dataPath = path.join(patternsDir, file);
        const data = await fs.readJson(dataPath);

        // Skip if bboxes already extracted (either via this script or inline from pattern extractor)
        const components = data.extraction?.components || [];
        const allHaveBbox = components.length > 0 && components.every(c => c.bbox);
        if (data.bboxes_extracted || allHaveBbox) {
          totalSkipped++;
          return;
        }

        if (components.length === 0) {
          totalSkipped++;
          return;
        }

        const imageFile = data.file;
        const imagePath = path.join(PATHS.screens, industryId, imageFile);
        if (!await fs.pathExists(imagePath)) {
          logWarn(`  Image not found: ${imageFile}`);
          totalSkipped++;
          return;
        }

        // Get bounding boxes from Claude Vision
        const bboxes = await extractBboxes(imagePath, components, data.screen_id);

        if (bboxes) {
          // Merge bboxes into component data
          for (let i = 0; i < components.length; i++) {
            if (bboxes[i]) {
              components[i].bbox = bboxes[i];
            }
          }

          data.extraction.components = components;
          data.bboxes_extracted = true;
          data.bboxes_extracted_at = new Date().toISOString();
          await fs.writeJson(dataPath, data, { spaces: 2 });
          totalProcessed++;
        } else {
          totalErrors++;
        }
      } catch (err) {
        logError(`  Failed ${file}: ${err.message}`);
        totalErrors++;
      }
    });
  }

  costTracker.print();

  logInfo(`Processed: ${totalProcessed}, Skipped: ${totalSkipped}, Errors: ${totalErrors}`);

  // Now crop
  logInfo('Generating crops from bounding boxes...');
  for (const industryId of industries) {
    await cropFromBboxes(industryId);
  }

  logSuccess('Done');
}

// ─── Bounding Box Extraction ──────────────────────────────────────────────────

async function extractBboxes(imagePath, components, screenId) {
  const imageBuffer = await resizeForVision(imagePath, 1568);
  const ext = path.extname(imagePath).toLowerCase();
  const mediaType = mimeFromExt(ext);
  const base64 = imageBuffer.toString('base64');

  // Build compact component list for the prompt
  const compList = components.map((c, i) => ({
    index: i,
    label: c.label,
    category: c.category,
    region: c.spatial_footprint?.region || 'unknown',
  }));

  // Get actual dimensions of the resized image for context
  const resizedMeta = await sharp(imageBuffer).metadata();
  const resW = resizedMeta.width;
  const resH = resizedMeta.height;

  const prompt = `This UI screenshot is ${resW} pixels wide and ${resH} pixels tall. It may be a scrollable/long screenshot.

Locate each UI component listed below and return its bounding box in PIXEL coordinates:
- x: left edge in pixels (0 to ${resW})
- y: top edge in pixels (0 to ${resH})
- w: width in pixels
- h: height in pixels

Components to locate:
${JSON.stringify(compList, null, 2)}

Return ONLY valid JSON array, one bbox per component, same order:
[
  { "index": 0, "x": 0, "y": 0, "w": ${resW}, "h": 45 },
  { "index": 1, "x": 20, "y": 50, "w": 680, "h": 120 }
]

IMPORTANT:
- The image is ${resH}px tall. Components near the bottom of this long image will have large y values (e.g., y=1400).
- Be precise. Measure pixel positions carefully against the actual image content.
- Every component MUST have a unique y position — do not put all components at the same y.`;

  let lastError = null;
  let backoff = INITIAL_BACKOFF;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: base64 },
              },
              { type: 'text', text: prompt },
            ],
          },
        ],
      });

      const usage = response.usage || {};
      const callCost = costTracker.addCall({
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cachedTokens: usage.cache_read_input_tokens || 0,
      });
      logDim(`  ${screenId}: $${callCost.toFixed(4)}`);

      const text = response.content[0]?.text || '';
      const bboxes = parseJsonResponse(text, 'array');

      if (!Array.isArray(bboxes)) throw new Error('Response is not an array');

      // Map to indexed result — convert pixels to percentages
      const result = new Array(components.length).fill(null);
      for (const bb of bboxes) {
        const idx = bb.index != null ? bb.index : bboxes.indexOf(bb);
        if (idx >= 0 && idx < components.length) {
          result[idx] = {
            x: Math.max(0, Math.min(100, (bb.x / resW) * 100)),
            y: Math.max(0, Math.min(100, (bb.y / resH) * 100)),
            w: Math.max(1, Math.min(100, (bb.w / resW) * 100)),
            h: Math.max(1, Math.min(100, (bb.h / resH) * 100)),
          };
        }
      }

      return result;

    } catch (err) {
      lastError = err;

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

  logError(`  ${screenId}: All retries exhausted — ${lastError?.message}`);
  return null;
}

// ─── Crop from Bounding Boxes ─────────────────────────────────────────────────

async function cropFromBboxes(industryId) {
  const patternsDir = path.join(PATHS.patterns, industryId);
  if (!await fs.pathExists(patternsDir)) return;

  const cropDir = path.join(CROP_DIR, industryId);
  await ensureDirs(cropDir);

  const files = (await fs.readdir(patternsDir)).filter(f => f.endsWith('.json'));
  let cropped = 0;
  let skipped = 0;

  for (const file of files) {
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
      const bbox = comp.bbox;
      if (!bbox) { skipped++; continue; }

      const compId = comp.component_id || `${data.screen_id}__${comp.category}_${String(i).padStart(2, '0')}`;
      const cropPath = path.join(cropDir, `${compId}.png`);

      // Skip existing
      if (await fs.pathExists(cropPath)) { skipped++; continue; }

      // Convert percentage bbox to pixels
      const left = Math.max(0, Math.floor((bbox.x / 100) * imgW));
      const top = Math.max(0, Math.floor((bbox.y / 100) * imgH));
      let width = Math.floor((bbox.w / 100) * imgW);
      let height = Math.floor((bbox.h / 100) * imgH);

      // Clamp to image bounds
      width = Math.min(width, imgW - left);
      height = Math.min(height, imgH - top);

      if (width < 5 || height < 5) { skipped++; continue; }

      try {
        await sharp(imagePath)
          .extract({ left, top, width, height })
          .png()
          .toFile(cropPath);
        cropped++;
      } catch (err) {
        logError(`  Crop failed ${compId}: ${err.message}`);
      }
    }
  }

  if (cropped > 0 || skipped > 0) {
    logSuccess(`${industryId}: ${cropped} cropped, ${skipped} skipped`);
  }
}

main();
