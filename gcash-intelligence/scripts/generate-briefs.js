#!/usr/bin/env node

import 'dotenv/config';
import { BriefGenerator } from '../src/brief-generator.js';
import { logError } from '../src/utils.js';

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   GCash Intelligence — Visual Direction Briefs    ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  if (!process.env.ANTHROPIC_API_KEY) {
    logError('ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }

  try {
    const generator = new BriefGenerator();
    await generator.run();
  } catch (err) {
    logError(`Brief generation failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

main();
