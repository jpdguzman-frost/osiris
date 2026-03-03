#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config({ override: true });
import { Auditor } from '../src/auditor.js';
import { logError } from '../src/utils.js';

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║       GCash Intelligence — GCash Audit            ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  if (!process.env.ANTHROPIC_API_KEY) {
    logError('ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }

  try {
    const auditor = new Auditor();
    await auditor.run();
  } catch (err) {
    logError(`Audit failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

main();
