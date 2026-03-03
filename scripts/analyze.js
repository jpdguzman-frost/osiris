#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config({ override: true });
import { Analyzer } from '../src/analyzer.js';
import { logInfo, logError } from '../src/utils.js';

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

const concurrency = flags.concurrency ? parseInt(flags.concurrency, 10) : undefined;
const source = flags.source || undefined;

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║       GCash Intelligence — Vision Analyzer        ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  if (!process.env.ANTHROPIC_API_KEY) {
    logError('ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }

  const analyzer = new Analyzer({
    budgetCap: parseFloat(process.env.BUDGET_CAP) || 200,
    ...(concurrency && { concurrency }),
  });

  if (industryFilter) {
    logInfo(`Industries: ${industryFilter.join(', ')}`);
  } else {
    logInfo('Analyzing ALL industries');
  }

  try {
    const results = await analyzer.analyzeAll(industryFilter);

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║              Analysis Summary                     ║');
    console.log('╠══════════════════════════════════════════════════╣');
    for (const [id, r] of Object.entries(results)) {
      console.log(`║  ${id.padEnd(15)} ${String(r.analyzed).padStart(4)} new | ${String(r.skipped).padStart(4)} skip | ${String(r.errors).padStart(3)} err ║`);
    }
    console.log('╚══════════════════════════════════════════════════╝\n');
  } catch (err) {
    logError(`Analysis failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

main();
