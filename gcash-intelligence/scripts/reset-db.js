#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config({ override: true });
import { MongoClient } from 'mongodb';
import { logSuccess, logError } from '../src/utils.js';

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = 'osiris';

async function main() {
  console.log('\n⚠  Dropping database: ' + DB_NAME + '\n');

  const client = new MongoClient(uri);
  try {
    await client.connect();
    await client.db(DB_NAME).dropDatabase();
    logSuccess(`Database "${DB_NAME}" dropped successfully`);
  } catch (err) {
    logError(`Failed to drop database: ${err.message}`);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
