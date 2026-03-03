#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config({ override: true });
import { Analyzer } from '../src/analyzer.js';
import { logInfo, logSuccess, logWarn } from '../src/utils.js';
import readline from 'readline';

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║      GCash Intelligence — Cost Estimator          ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const analyzer = new Analyzer();
  const estimate = await analyzer.estimateCost();

  console.log('┌─────────────── Estimate ────────────────────────┐');
  console.log(`│ Total screens:     ${String(estimate.totalScreens).padStart(24)} │`);
  console.log(`│ Already analyzed:  ${String(estimate.alreadyAnalyzed).padStart(24)} │`);
  console.log(`│ Remaining:         ${String(estimate.remaining).padStart(24)} │`);
  console.log(`│ Est. cost/screen:  ${('$' + estimate.estimatedPerScreen.toFixed(4)).padStart(24)} │`);
  console.log(`│ Est. total cost:   ${('$' + estimate.estimatedCost.toFixed(2)).padStart(24)} │`);
  console.log(`│ Budget cap:        ${('$' + estimate.budgetCap.toFixed(2)).padStart(24)} │`);
  console.log(`│ Budget usage:      ${(estimate.budgetPct + '%').padStart(24)} │`);
  console.log('└────────────────────────────────────────────────┘\n');

  if (estimate.remaining === 0) {
    logSuccess('All screens already analyzed. Nothing to do.');
    return;
  }

  if (parseFloat(estimate.budgetPct) > 100) {
    logWarn(`Estimated cost exceeds budget cap of $${estimate.budgetCap}.`);
    logWarn('Consider reducing the number of screens or increasing the budget cap.');
  }

  // Ask for confirmation
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => {
    rl.question(`Proceed with analysis of ${estimate.remaining} screens for ~$${estimate.estimatedCost.toFixed(2)}? (y/n) `, resolve);
  });
  rl.close();

  if (answer.toLowerCase() === 'y') {
    logInfo('Starting analysis...\n');
    const results = await analyzer.analyzeAll();
    console.log('\nAnalysis complete.');
  } else {
    console.log('Cancelled.');
  }
}

main();
