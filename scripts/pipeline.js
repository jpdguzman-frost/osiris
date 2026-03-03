#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config({ override: true });
import { execFile } from 'child_process';
import { logInfo, logSuccess, logError, parseFlags } from '../src/utils.js';

const { flags } = parseFlags();

const STEPS = [
  { name: 'analyze', script: 'scripts/analyze.js', passIndustry: true },
  { name: 'ingest', script: 'scripts/ingest.js', passIndustry: true },
  { name: 'fingerprint', script: 'scripts/fingerprint.js', passIndustry: false },
  { name: 'stats', script: 'scripts/stats.js', passIndustry: false },
];

function runStep(script, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = execFile('node', [script, ...extraArgs], {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });

    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);

    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`${script} exited with code ${code}`));
      else resolve();
    });
  });
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║     GCash Intelligence — Full Pipeline            ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const started = Date.now();

  // Build industry args to forward
  const industryArgs = [];
  if (flags.industry) industryArgs.push(`--industry=${flags.industry}`);
  if (flags.concurrency) industryArgs.push(`--concurrency=${flags.concurrency}`);

  if (flags.industry) logInfo(`Industry filter: ${flags.industry}`);

  for (const step of STEPS) {
    const extra = step.passIndustry ? industryArgs : [];
    console.log(`\n${'═'.repeat(54)}`);
    logInfo(`Step: ${step.name}`);
    console.log(`${'═'.repeat(54)}\n`);

    try {
      await runStep(step.script, extra);
    } catch (err) {
      logError(`Pipeline stopped at ${step.name}: ${err.message}`);
      process.exit(1);
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${'═'.repeat(54)}`);
  logSuccess(`Pipeline complete in ${elapsed}s`);
  console.log(`${'═'.repeat(54)}\n`);
}

main();
