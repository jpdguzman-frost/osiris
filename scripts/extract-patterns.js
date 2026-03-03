#!/usr/bin/env node

import 'dotenv/config';
import { PatternExtractor } from '../src/pattern-extractor.js';
import { logInfo, logSuccess, logError, logWarn } from '../src/utils.js';

// ─── Parse CLI Args ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {};
for (const arg of args) {
  if (arg.startsWith('--')) {
    const [key, val] = arg.slice(2).split('=');
    flags[key] = val || true;
  }
}

const industryFilter = flags.industry
  ? flags.industry.split(',').map(s => s.trim())
  : null;

const extractOnly = flags['extract-only'] === true;
const cropOnly = flags['crop-only'] === true;
const htmlOnly = flags['html-only'] === true;

// ─── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   GCash Intelligence — Component Pattern Extractor       ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  if (!process.env.ANTHROPIC_API_KEY) {
    logError('ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }

  const extractor = new PatternExtractor({
    budgetCap: parseFloat(process.env.BUDGET_CAP) || 200,
  });

  if (industryFilter) {
    logInfo(`Industries: ${industryFilter.join(', ')}`);
  }

  try {
    if (htmlOnly) {
      logInfo('Regenerating HTML pattern library only');
      await extractor.generatePatternLibraryHtml();
    } else if (cropOnly) {
      logInfo('Running crop only');
      await extractor.cropComponents(industryFilter);
    } else if (extractOnly) {
      logInfo('Running extraction only (skipping crop/ingest/HTML)');
      await extractor.extractAll(industryFilter);
    } else {
      logInfo('Running full pipeline: extract → crop → ingest → HTML');
      await extractor.run(industryFilter);
    }

    logSuccess('Pattern extraction complete');
  } catch (err) {
    logError(`Pattern extraction failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

main();
