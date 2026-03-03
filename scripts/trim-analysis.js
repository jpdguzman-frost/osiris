#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config({ override: true });
import fs from 'fs-extra';
import path from 'path';
import { logInfo, logSuccess, logWarn, logError, logDim, PATHS, parseFlags } from '../src/utils.js';

const { flags, industryFilter } = parseFlags();
const dryRun = flags['dry-run'] === true;

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   GCash Intelligence — Trim Screen Analysis Data         ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  if (dryRun) logWarn('DRY RUN — no files will be modified\n');

  const analysisBase = PATHS.analysis;
  const dirs = (await fs.readdir(analysisBase)).filter(async f => {
    try { return (await fs.stat(path.join(analysisBase, f))).isDirectory(); } catch { return false; }
  });

  // Resolve directories
  const industries = [];
  for (const d of dirs) {
    const full = path.join(analysisBase, d);
    if ((await fs.stat(full)).isDirectory()) {
      if (!industryFilter || industryFilter.includes(d)) {
        industries.push(d);
      }
    }
  }

  let totalFiles = 0;
  let totalTrimmed = 0;
  let totalSkipped = 0;
  let totalBytesBefore = 0;
  let totalBytesAfter = 0;

  for (const industryId of industries) {
    const dir = path.join(analysisBase, industryId);
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));

    if (files.length === 0) continue;

    let trimmed = 0;
    let skipped = 0;
    let bytesBefore = 0;
    let bytesAfter = 0;

    for (const file of files) {
      const filePath = path.join(dir, file);
      const raw = await fs.readFile(filePath, 'utf-8');
      bytesBefore += raw.length;

      const data = JSON.parse(raw);
      const analysis = data.analysis;
      if (!analysis) {
        skipped++;
        bytesAfter += raw.length;
        continue;
      }

      // Check if already trimmed (no recommendations = likely already lean)
      const hasOldFields = analysis.recommendations ||
                           analysis.dated_elements ||
                           analysis.missed_opportunities ||
                           analysis.strengths_to_preserve ||
                           analysis.color_analysis?.saturation_approach ||
                           analysis.typography_analysis?.text_treatments ||
                           analysis.spatial_analysis?.key_spatial_technique ||
                           analysis.identity_signals?.category_conventions ||
                           analysis.principles_extracted?.some(p => p.transferability);

      if (!hasOldFields) {
        skipped++;
        bytesAfter += raw.length;
        continue;
      }

      // ── Trim analysis fields ──

      // Remove GCash business layer
      delete analysis.recommendations;
      delete analysis.dated_elements;
      delete analysis.missed_opportunities;
      delete analysis.strengths_to_preserve;

      // Trim color_analysis
      if (analysis.color_analysis) {
        delete analysis.color_analysis.saturation_approach;
      }

      // Trim typography_analysis
      if (analysis.typography_analysis) {
        delete analysis.typography_analysis.text_treatments;
      }

      // Trim spatial_analysis
      if (analysis.spatial_analysis) {
        delete analysis.spatial_analysis.key_spatial_technique;
      }

      // Trim identity_signals
      if (analysis.identity_signals) {
        delete analysis.identity_signals.category_conventions;
      }

      // Remove transferability from principles (GCash business judgment)
      if (analysis.principles_extracted) {
        for (const p of analysis.principles_extracted) {
          delete p.transferability;
        }
      }

      const trimmedJson = JSON.stringify(data, null, 2);
      bytesAfter += trimmedJson.length;

      if (!dryRun) {
        await fs.writeFile(filePath, trimmedJson + '\n');
      }

      trimmed++;
    }

    totalFiles += files.length;
    totalTrimmed += trimmed;
    totalSkipped += skipped;
    totalBytesBefore += bytesBefore;
    totalBytesAfter += bytesAfter;

    const saved = bytesBefore - bytesAfter;
    const pct = bytesBefore > 0 ? ((saved / bytesBefore) * 100).toFixed(1) : 0;
    logInfo(`${industryId}: ${files.length} files — ${trimmed} trimmed, ${skipped} skipped (${pct}% smaller)`);
  }

  const totalSaved = totalBytesBefore - totalBytesAfter;
  const totalPct = totalBytesBefore > 0 ? ((totalSaved / totalBytesBefore) * 100).toFixed(1) : 0;

  console.log('');
  logSuccess(`Done: ${totalTrimmed} trimmed, ${totalSkipped} skipped out of ${totalFiles} files`);
  logSuccess(`Size: ${(totalBytesBefore / 1024).toFixed(1)} KB → ${(totalBytesAfter / 1024).toFixed(1)} KB (${totalPct}% reduction, saved ${(totalSaved / 1024).toFixed(1)} KB)`);

  if (dryRun) {
    console.log('');
    logWarn('This was a dry run. Run without --dry-run to apply changes.');
  }
}

main().catch(err => {
  logError(err.message);
  process.exit(1);
});
