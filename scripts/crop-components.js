#!/usr/bin/env node

import fs from 'fs-extra';
import path from 'path';
import sharp from 'sharp';
import { logInfo, logSuccess, logError, logDim, logProgress, ensureDirs, PATHS } from '../src/utils.js';

const CROP_DIR = path.join(PATHS.data, 'patterns', 'crops');

// Region bands as percentage of image height
const REGION_BANDS = {
  top:     { start: 0,   end: 0.33 },
  middle:  { start: 0.2, end: 0.85 },
  bottom:  { start: 0.67, end: 1.0 },
  overlay: { start: 0.1, end: 0.9 },
  full:    { start: 0,   end: 1.0 },
  left:    { start: 0,   end: 1.0 },
  right:   { start: 0,   end: 1.0 },
};

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   GCash Intelligence — Component Crop Processor          ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const config = await fs.readJson(path.join(PATHS.config, 'industries.json'));
  const industries = config.industries.map(i => i.id);
  if (await fs.pathExists(path.join(PATHS.patterns, 'gcash_current'))) {
    industries.push('gcash_current');
  }

  let totalCropped = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const industryId of industries) {
    const patternsDir = path.join(PATHS.patterns, industryId);
    if (!await fs.pathExists(patternsDir)) continue;

    const cropDir = path.join(CROP_DIR, industryId);
    await ensureDirs(cropDir);

    const files = (await fs.readdir(patternsDir)).filter(f => f.endsWith('.json'));
    logInfo(`${industryId}: Processing ${files.length} screens`);

    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi];
      logProgress(fi + 1, files.length, file.slice(0, 40));

      try {
        const data = await fs.readJson(path.join(patternsDir, file));
        const components = data.extraction?.components || [];
        const screenId = data.screen_id;
        const imageFile = data.file;

        if (!imageFile) continue;

        const imagePath = path.join(PATHS.screens, industryId, imageFile);
        if (!await fs.pathExists(imagePath)) {
          logDim(`  Skipping ${screenId} — image not found`);
          continue;
        }

        // Get image dimensions
        const meta = await sharp(imagePath).metadata();
        const imgW = meta.width;
        const imgH = meta.height;

        // Group components by region to estimate stacking positions
        const regionGroups = {};
        components.forEach((comp, idx) => {
          const region = comp.spatial_footprint?.region || 'middle';
          if (!regionGroups[region]) regionGroups[region] = [];
          regionGroups[region].push({ ...comp, originalIdx: idx });
        });

        // Calculate Y positions by stacking within each region band
        const componentPositions = new Array(components.length);

        for (const [region, group] of Object.entries(regionGroups)) {
          const band = REGION_BANDS[region] || REGION_BANDS.middle;
          const bandStartPx = Math.floor(band.start * imgH);
          const bandEndPx = Math.floor(band.end * imgH);
          const bandHeight = bandEndPx - bandStartPx;

          // Total claimed height percentage in this band
          const totalClaimedPct = group.reduce((sum, c) => {
            return sum + (c.spatial_footprint?.approximate_height_pct || 10);
          }, 0);

          // Stack components sequentially within the band
          let currentY = bandStartPx;
          for (const comp of group) {
            const heightPct = comp.spatial_footprint?.approximate_height_pct || 10;
            const widthPct = comp.spatial_footprint?.approximate_width_pct || 100;

            // Scale height proportionally if total exceeds band
            const scaleFactor = totalClaimedPct > 0
              ? Math.min(1, bandHeight / (totalClaimedPct / 100 * imgH))
              : 1;

            const cropH = Math.max(
              Math.floor((heightPct / 100) * imgH * scaleFactor),
              40 // minimum 40px
            );
            const cropW = Math.max(
              Math.floor((widthPct / 100) * imgW),
              100
            );

            // Center horizontally
            const cropX = Math.max(0, Math.floor((imgW - cropW) / 2));

            // Clamp Y within image bounds
            const cropY = Math.max(0, Math.min(currentY, imgH - cropH));

            componentPositions[comp.originalIdx] = {
              x: cropX,
              y: cropY,
              w: Math.min(cropW, imgW - cropX),
              h: Math.min(cropH, imgH - cropY),
            };

            currentY += cropH;
          }
        }

        // Crop each component
        for (let i = 0; i < components.length; i++) {
          const comp = components[i];
          const compId = comp.component_id || `${screenId}__${comp.category}_${String(i).padStart(2, '0')}`;
          const cropPath = path.join(cropDir, `${compId}.png`);

          // Skip if already cropped
          if (await fs.pathExists(cropPath)) {
            totalSkipped++;
            continue;
          }

          const pos = componentPositions[i];
          if (!pos || pos.w < 10 || pos.h < 10) {
            totalSkipped++;
            continue;
          }

          try {
            await sharp(imagePath)
              .extract({
                left: pos.x,
                top: pos.y,
                width: pos.w,
                height: pos.h,
              })
              .png()
              .toFile(cropPath);

            totalCropped++;
          } catch (err) {
            logError(`  Crop failed ${compId}: ${err.message}`);
            totalErrors++;
          }
        }
      } catch (err) {
        logError(`  Failed ${file}: ${err.message}`);
        totalErrors++;
      }
    }
  }

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║                  Crop Summary                            ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Cropped:  ${String(totalCropped).padStart(6)}                                    ║`);
  console.log(`║  Skipped:  ${String(totalSkipped).padStart(6)}                                    ║`);
  console.log(`║  Errors:   ${String(totalErrors).padStart(6)}                                    ║`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  logSuccess(`Crops saved to ${CROP_DIR}`);
}

main();
