#!/usr/bin/env node

import 'dotenv/config';
import { logInfo, logSuccess, logError, logWarn } from '../src/utils.js';
import { Collector } from '../src/collector.js';
import { Analyzer } from '../src/analyzer.js';
import { Store } from '../src/store.js';
import { Synthesizer } from '../src/synthesizer.js';
import { Auditor } from '../src/auditor.js';
import { PatternExtractor } from '../src/pattern-extractor.js';
import { BriefGenerator } from '../src/brief-generator.js';
import { LibraryCompiler } from '../src/library-compiler.js';

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║     GCash Intelligence — Full Pipeline Run               ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const steps = [
    { name: 'Collect', fn: runCollect },
    { name: 'Analyze', fn: runAnalyze },
    { name: 'Ingest', fn: runIngest },
    { name: 'Synthesize', fn: runSynthesize },
    { name: 'Audit', fn: runAudit },
    { name: 'Extract Patterns', fn: runPatterns },
    { name: 'Generate Briefs', fn: runBriefs },
    { name: 'Compile Library', fn: runLibrary },
  ];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    console.log(`\n${'━'.repeat(60)}`);
    logInfo(`Step ${i + 1}/${steps.length}: ${step.name}`);
    console.log(`${'━'.repeat(60)}`);

    try {
      await step.fn();
      logSuccess(`${step.name} complete`);
    } catch (err) {
      logError(`${step.name} failed: ${err.message}`);
      console.error(err);
      logWarn('Continuing with next step...');
    }
  }

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║                    Pipeline Complete                      ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  Output:                                                 ║');
  console.log('║    output/briefs/direction_{1,2,3}.md                    ║');
  console.log('║    data/synthesis/cross_industry_synthesis.json           ║');
  console.log('║    data/synthesis/gcash_audit.json                        ║');
  console.log('║    output/library/index.html                              ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
}

async function runCollect() {
  const collector = new Collector();
  await collector.collectAll();
}

async function runAnalyze() {
  if (!process.env.ANTHROPIC_API_KEY) {
    logWarn('ANTHROPIC_API_KEY not set — skipping analysis');
    return;
  }
  const analyzer = new Analyzer();
  await analyzer.analyzeAll();
}

async function runIngest() {
  const store = new Store();
  try {
    await store.ingestAnalysis();
  } finally {
    await store.close();
  }
}

async function runSynthesize() {
  if (!process.env.ANTHROPIC_API_KEY) {
    logWarn('ANTHROPIC_API_KEY not set — skipping synthesis');
    return;
  }
  const synthesizer = new Synthesizer();
  await synthesizer.run();
}

async function runAudit() {
  if (!process.env.ANTHROPIC_API_KEY) {
    logWarn('ANTHROPIC_API_KEY not set — skipping audit');
    return;
  }
  const auditor = new Auditor();
  await auditor.run();
}

async function runPatterns() {
  if (!process.env.ANTHROPIC_API_KEY) {
    logWarn('ANTHROPIC_API_KEY not set — skipping pattern extraction');
    return;
  }
  const extractor = new PatternExtractor();
  await extractor.run();
}

async function runBriefs() {
  if (!process.env.ANTHROPIC_API_KEY) {
    logWarn('ANTHROPIC_API_KEY not set — skipping briefs');
    return;
  }
  const generator = new BriefGenerator();
  await generator.run();
}

async function runLibrary() {
  const compiler = new LibraryCompiler();
  await compiler.run();
}

main();
