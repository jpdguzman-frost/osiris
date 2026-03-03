#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config({ override: true });
import { LibraryCompiler } from '../src/library-compiler.js';
import { logError } from '../src/utils.js';

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║    GCash Intelligence — HTML Reference Gallery    ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  try {
    const compiler = new LibraryCompiler();
    await compiler.run();
  } catch (err) {
    logError(`Library compilation failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

main();
