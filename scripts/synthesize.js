#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config({ override: true });
import { Synthesizer } from '../src/synthesizer.js';
import { logError } from '../src/utils.js';

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║     GCash Intelligence — Pattern Synthesis         ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  if (!process.env.ANTHROPIC_API_KEY) {
    logError('ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }

  try {
    const synthesizer = new Synthesizer();
    await synthesizer.run();
  } catch (err) {
    logError(`Synthesis failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

main();
