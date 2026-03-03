#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config({ override: true });
import { Collector } from '../src/collector.js';
import { logInfo, logSuccess, logError, parseFlags } from '../src/utils.js';

const { flags, industryFilter } = parseFlags();
const noPuppeteer = flags['no-puppeteer'] === true;

// ─── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║        GCash Intelligence — Screen Collector      ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  if (industryFilter) {
    logInfo(`Industries: ${industryFilter.join(', ')}`);
  } else {
    logInfo('Collecting ALL industries');
  }

  // Report config
  if (process.env.GOOGLE_API_KEY && process.env.GOOGLE_CSE_ID) {
    logSuccess('Google Custom Search API configured');
  } else {
    logInfo('No Google CSE keys — will collect from web targets only');
    logInfo('Set GOOGLE_API_KEY and GOOGLE_CSE_ID in .env for search-based collection');
  }

  const collector = new Collector({
    usePuppeteer: !noPuppeteer,
  });

  try {
    const results = await collector.collectAll(industryFilter);

    // Summary
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║                Collection Summary                 ║');
    console.log('╠══════════════════════════════════════════════════╣');
    let totalSaved = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    for (const [id, r] of Object.entries(results)) {
      console.log(`║  ${id.padEnd(15)} ${String(r.saved).padStart(4)} saved | ${String(r.total).padStart(4)} total ║`);
      totalSaved += r.saved;
      totalSkipped += r.skipped;
      totalErrors += r.errors;
    }
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║  TOTAL          ${String(totalSaved).padStart(4)} saved | ${String(totalSkipped).padStart(4)} skip | ${String(totalErrors).padStart(3)} err  ║`);
    console.log('╚══════════════════════════════════════════════════╝\n');

    if (totalSaved === 0) {
      logInfo('No images collected. To collect via search:');
      logInfo('  1. Create a Google Programmable Search Engine at https://programmablesearchengine.google.com/');
      logInfo('  2. Enable "Image search" in the CSE settings');
      logInfo('  3. Add GOOGLE_API_KEY and GOOGLE_CSE_ID to your .env file');
      logInfo('  4. Re-run: node scripts/collect.js --industry=luxury');
    }
  } catch (err) {
    logError(`Collection failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

main();
