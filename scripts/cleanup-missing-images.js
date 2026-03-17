#!/usr/bin/env node

// Removes MongoDB screen entries whose image file doesn't exist on disk.
// Usage: node scripts/cleanup-missing-images.js [--dry-run]

import path from 'path';
import fs from 'fs-extra';
import { Store } from '../src/store.js';
import { PATHS, logInfo, logWarn, logSuccess, logError } from '../src/utils.js';

const DRY_RUN = process.argv.includes('--dry-run');

if (DRY_RUN) logInfo('DRY RUN — no records will be deleted');

const store = new Store();
await store.connect();

const screens = await store.db.collection('screens')
  .find({})
  .project({ screen_id: 1, industry: 1, file_path: 1 })
  .toArray();

logInfo(`Checking ${screens.length} screens for missing images...`);

const missing = [];

for (const s of screens) {
  if (!s.file_path || !s.industry) {
    missing.push(s);
    continue;
  }
  const imagePath = path.join(PATHS.screens, s.industry, s.file_path);
  if (!await fs.pathExists(imagePath)) {
    missing.push(s);
  }
}

if (missing.length === 0) {
  logSuccess('All screen images exist. Nothing to clean up.');
  process.exit(0);
}

logWarn(`Found ${missing.length} screens with missing images:`);
for (const s of missing.slice(0, 20)) {
  const img = s.file_path ? path.join(s.industry || '?', s.file_path) : '(no file_path)';
  logWarn(`  ${s.screen_id} → ${img}`);
}
if (missing.length > 20) logWarn(`  ... and ${missing.length - 20} more`);

if (!DRY_RUN) {
  const ids = missing.map(s => s.screen_id);
  const result = await store.db.collection('screens').deleteMany({ screen_id: { $in: ids } });
  logSuccess(`Deleted ${result.deletedCount} screen records.`);
} else {
  logInfo(`Would delete ${missing.length} records. Run without --dry-run to execute.`);
}

process.exit(0);
