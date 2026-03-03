#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config({ override: true });
import { Store } from '../src/store.js';
import { logInfo, logSuccess, logError } from '../src/utils.js';

const args = process.argv.slice(2);
const flags = {};
for (const arg of args) {
  if (arg.startsWith('--')) {
    const [key, val] = arg.slice(2).split('=');
    flags[key] = val || true;
  }
}

// Score fields that support --{field}-min=N
const SCORE_FIELDS = [
  'color_restraint', 'hierarchy_clarity', 'glanceability', 'density',
  'whitespace_ratio', 'brand_confidence', 'calm_confident', 'bold_forward',
  'overall_quality',
];

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║       GCash Intelligence — Distill Screens        ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const store = new Store();

  try {
    await store.connect();

    // Build query options from flags
    const options = {};

    if (flags.tags) {
      options.tags = flags.tags.split(',').map(s => s.trim());
    }
    if (flags['screen-type']) options.screenType = flags['screen-type'];
    if (flags.layout) options.layoutType = flags.layout;
    if (flags.mood) options.designMood = flags.mood;
    if (flags.industry) options.industry = flags.industry;
    if (flags.source) options.source = flags.source;
    if (flags.sort) options.sort = flags.sort;
    if (flags.limit) options.limit = parseInt(flags.limit, 10);

    // Parse score minimums (e.g., --calm-confident-min=7)
    const minScores = {};
    for (const field of SCORE_FIELDS) {
      const flagKey = field.replace(/_/g, '-') + '-min';
      if (flags[flagKey]) {
        minScores[field] = parseFloat(flags[flagKey]);
      }
    }
    if (Object.keys(minScores).length > 0) {
      options.minScores = minScores;
    }

    logInfo(`Query: ${JSON.stringify(options, null, 2)}`);

    const results = await store.distill(options);
    logSuccess(`Found ${results.length} screens`);

    // Display results
    console.log('');
    for (let i = 0; i < results.length; i++) {
      const s = results[i];
      const scores = s.analysis?.scores || {};
      const fp = s.fingerprint || {};
      console.log(`  ${String(i + 1).padStart(3)}. ${s.screen_id}`);
      console.log(`       Industry: ${s.industry} | Source: ${s.source} | Type: ${s.analysis?.screen_type || '?'}`);
      console.log(`       Quality: ${scores.overall_quality || '?'} | Calm: ${scores.calm_confident || '?'} | Bold: ${scores.bold_forward || '?'}`);
      if (fp.style_tags?.length) {
        console.log(`       Tags: ${fp.style_tags.join(', ')}`);
      }
      console.log('');
    }

    // Save distillation if --save flag provided
    if (flags.save && results.length > 0) {
      const screenIds = results.map(r => r.screen_id);
      await store.saveDistillation(flags.save, options, screenIds);
      logSuccess(`Saved distillation "${flags.save}" with ${screenIds.length} screens`);
    }

  } catch (err) {
    logError(`Distill failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  } finally {
    await store.close();
  }
}

main();
