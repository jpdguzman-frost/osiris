#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config({ override: true });
import path from 'path';
import fs from 'fs-extra';
import { Store } from '../src/store.js';
import { extractAllFeatures } from '../src/fingerprint.js';
import { logInfo, logSuccess, logWarn, logError, logProgress, promisePool, PATHS } from '../src/utils.js';

const CONCURRENCY = 10;

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║    GCash Intelligence — Visual Fingerprinting     ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const store = new Store();

  try {
    await store.connect();

    // Find screens missing visual_features
    const allScreens = await store.getAllScreenIds();
    const missing = allScreens.filter(s => !s.visual_features);

    logInfo(`Total screens: ${allScreens.length}, missing visual features: ${missing.length}`);

    if (missing.length === 0) {
      logSuccess('All screens already have visual features');
      return;
    }

    let processed = 0;
    let errors = 0;

    await promisePool(missing, CONCURRENCY, async (screen, idx) => {
      logProgress(idx + 1, missing.length, screen.screen_id?.slice(0, 50));

      const filePath = screen.file_path;
      if (!filePath) {
        logWarn(`No file_path for ${screen.screen_id}`);
        errors++;
        return;
      }

      // Resolve full path: try absolute, then screens/filename, then screens/industry/filename
      let resolvedPath = null;
      const candidates = [
        path.isAbsolute(filePath) ? filePath : null,
        path.join(PATHS.screens, filePath),
        screen.industry ? path.join(PATHS.screens, screen.industry, filePath) : null,
      ].filter(Boolean);

      for (const candidate of candidates) {
        if (await fs.pathExists(candidate)) {
          resolvedPath = candidate;
          break;
        }
      }

      if (!resolvedPath) {
        logWarn(`File not found: ${filePath} — removing orphan record ${screen.screen_id}`);
        await store.deleteScreen(screen.screen_id);
        errors++;
        return;
      }

      try {
        const features = await extractAllFeatures(resolvedPath);
        await store.updateVisualFeatures(screen.screen_id, features);
        processed++;
      } catch (err) {
        logError(`Failed ${screen.screen_id}: ${err.message}`);
        errors++;
      }
    });

    logSuccess(`Fingerprinted: ${processed} screens, ${errors} errors`);
  } catch (err) {
    logError(`Fingerprint failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  } finally {
    await store.close();
  }
}

main();
