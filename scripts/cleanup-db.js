#!/usr/bin/env node
/**
 * Osiris MongoDB Cleanup Script
 *
 * Removes collections that are no longer used by the application.
 * Run with --dry-run to preview changes without executing them.
 *
 * Usage:
 *   node scripts/cleanup-db.js              # Preview only (dry run)
 *   node scripts/cleanup-db.js --execute    # Actually drop collections
 */

import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env'), override: true });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'osiris';

// Collections actively used by the application (server.js + store.js on main)
const ACTIVE_COLLECTIONS = new Set([
  'screens',
  'buckets',
  'distillations',
]);

const execute = process.argv.includes('--execute');

async function main() {
  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    const db = client.db(DB_NAME);

    // List all collections in the database
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name).sort();

    console.log(`\n📦 Database: ${DB_NAME}`);
    console.log(`   Collections found: ${collectionNames.length}\n`);

    const toKeep = [];
    const toDrop = [];

    for (const name of collectionNames) {
      if (ACTIVE_COLLECTIONS.has(name)) {
        toKeep.push(name);
      } else {
        toDrop.push(name);
      }
    }

    // Show what's being kept
    console.log('✅ KEEP (actively used):');
    for (const name of toKeep) {
      const count = await db.collection(name).countDocuments();
      console.log(`   ${name} (${count} documents)`);
    }

    console.log('');

    // Show what's being dropped
    if (toDrop.length === 0) {
      console.log('🎉 No unused collections found. Database is clean.\n');
      return;
    }

    console.log('🗑  DROP (unused):');
    for (const name of toDrop) {
      const count = await db.collection(name).countDocuments();
      console.log(`   ${name} (${count} documents)`);
    }

    console.log('');

    if (!execute) {
      console.log('⚠️  DRY RUN — no changes made.');
      console.log('   Run with --execute to drop the unused collections.\n');
      return;
    }

    // Execute drops
    console.log('🔥 Dropping unused collections...');
    for (const name of toDrop) {
      await db.collection(name).drop();
      console.log(`   ✓ Dropped: ${name}`);
    }

    console.log('\n✅ Cleanup complete.\n');

  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
