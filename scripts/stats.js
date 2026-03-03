#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config({ override: true });
import { Store } from '../src/store.js';
import { logInfo, logError, PATHS, loadIndustries, IMAGE_EXT_RE } from '../src/utils.js';
import fs from 'fs-extra';
import path from 'path';

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║       GCash Intelligence — Pipeline Stats         ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // Local file stats
  console.log('── Local Files ──────────────────────────────────\n');
  const industries = await loadIndustries();

  let totalScreens = 0;
  let totalAnalyzed = 0;

  for (const id of industries) {
    const screensDir = path.join(PATHS.screens, id);
    const analysisDir = path.join(PATHS.analysis, id);

    const screens = await fs.pathExists(screensDir)
      ? (await fs.readdir(screensDir)).filter(f => IMAGE_EXT_RE.test(f)).length
      : 0;
    const analyzed = await fs.pathExists(analysisDir)
      ? (await fs.readdir(analysisDir)).filter(f => f.endsWith('.json')).length
      : 0;

    totalScreens += screens;
    totalAnalyzed += analyzed;

    const pct = screens > 0 ? ((analyzed / screens) * 100).toFixed(0) : '—';
    console.log(`  ${id.padEnd(16)} ${String(screens).padStart(4)} screens | ${String(analyzed).padStart(4)} analyzed (${pct}%)`);
  }

  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  ${'TOTAL'.padEnd(16)} ${String(totalScreens).padStart(4)} screens | ${String(totalAnalyzed).padStart(4)} analyzed`);

  // MongoDB stats (if available)
  try {
    const store = new Store();
    await store.connect();
    const stats = await store.getStats();

    console.log('\n── MongoDB ──────────────────────────────────────\n');
    console.log(`  Total screens:       ${stats.totalScreens}`);
    console.log(`  With fingerprints:   ${stats.withFingerprints}`);
    console.log(`  With visual features:${stats.withVisualFeatures}`);
    console.log(`  Distillations:       ${stats.distillationCount}`);
    console.log(`  Total API cost:      $${stats.totalCost.toFixed(2)}`);

    if (stats.totalScreens > 0) {
      console.log('\n  By Industry:');
      for (const [id, count] of Object.entries(stats.byIndustry)) {
        console.log(`    ${(id || 'unknown').padEnd(16)} ${count}`);
      }

      console.log('\n  By Source:');
      for (const [id, count] of Object.entries(stats.bySource)) {
        console.log(`    ${(id || 'unknown').padEnd(16)} ${count}`);
      }

      console.log('\n  Score Averages (by industry):');
      const keyScores = ['calm_confident', 'bold_forward', 'overall_quality'];
      for (const score of keyScores) {
        const data = stats.averages[score] || [];
        console.log(`\n    ${score}:`);
        for (const d of data) {
          console.log(`      ${(d._id || 'unknown').padEnd(16)} avg: ${d.avg?.toFixed(1) || '?'}  (${d.min?.toFixed(1) || '?'} - ${d.max?.toFixed(1) || '?'})`);
        }
      }
    }

    await store.close();
  } catch (err) {
    console.log('\n  MongoDB: not connected (' + err.message + ')');
  }

  console.log('');
}

main();
