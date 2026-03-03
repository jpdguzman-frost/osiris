#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config({ override: true });
import { Store } from '../src/store.js';
import { findSimilar, textSearch, WEIGHT_PRESETS } from '../src/similarity.js';
import { logInfo, logSuccess, logError } from '../src/utils.js';

const args = process.argv.slice(2);
const flags = {};
for (const arg of args) {
  if (arg.startsWith('--')) {
    const [key, val] = arg.slice(2).split('=');
    flags[key] = val || true;
  }
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║      GCash Intelligence — Similarity Search       ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const store = new Store();

  try {
    await store.connect();
    const allScreens = await store.getScreensWithFingerprints();
    logInfo(`Loaded ${allScreens.length} screens for search`);

    const top = parseInt(flags.top || '10', 10);
    const presetName = flags.weights || 'default';
    const weights = WEIGHT_PRESETS[presetName] || WEIGHT_PRESETS.default;

    if (flags['similar-to']) {
      // Similarity search
      const targetId = flags['similar-to'];
      const target = allScreens.find(s => s.screen_id === targetId);

      if (!target) {
        logError(`Screen not found: ${targetId}`);
        process.exit(1);
      }

      logInfo(`Finding screens similar to: ${targetId}`);
      logInfo(`Weights: ${presetName} (semantic=${weights.semantic}, visual=${weights.visual}, score=${weights.score})`);

      const results = findSimilar(target, allScreens, { weights, top });

      console.log(`\n  Top ${results.length} similar screens:\n`);
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const sim = r.similarity;
        console.log(`  ${String(i + 1).padStart(2)}. ${r.screen_id}`);
        console.log(`      Total: ${sim.total.toFixed(3)} | Semantic: ${sim.semantic.toFixed(3)} | Visual: ${sim.visual.toFixed(3)} | Score: ${sim.score.toFixed(3)}`);
        console.log(`      Industry: ${r.industry} | Source: ${r.source}`);
        console.log('');
      }

    } else if (flags.query) {
      // Text search
      logInfo(`Text search: "${flags.query}"`);

      const results = textSearch(flags.query, allScreens, { top });

      console.log(`\n  Top ${results.length} matches:\n`);
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        console.log(`  ${String(i + 1).padStart(2)}. ${r.screen_id} (relevance: ${r.relevance})`);
        console.log(`      Industry: ${r.industry} | ${r.verdict || ''}`);
        console.log('');
      }

    } else {
      console.log('  Usage:');
      console.log('    npm run search -- --similar-to=<screen_id> [--weights=visual|conceptual|quality|default] [--top=N]');
      console.log('    npm run search -- --query="editorial minimalist" [--top=N]');
    }

  } catch (err) {
    logError(`Search failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  } finally {
    await store.close();
  }
}

main();
