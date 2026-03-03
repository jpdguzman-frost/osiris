import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import sharp from 'sharp';

// ─── Logger ───────────────────────────────────────────────────────────────────

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

export function log(msg, color = 'white') {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`${COLORS.dim}[${ts}]${COLORS.reset} ${COLORS[color] || ''}${msg}${COLORS.reset}`);
}

export function logInfo(msg) { log(msg, 'cyan'); }
export function logSuccess(msg) { log(`✓ ${msg}`, 'green'); }
export function logWarn(msg) { log(`⚠ ${msg}`, 'yellow'); }
export function logError(msg) { log(`✗ ${msg}`, 'red'); }
export function logDim(msg) { log(msg, 'dim'); }

export function logProgress(current, total, label = '') {
  const pct = ((current / total) * 100).toFixed(1);
  const bar = '█'.repeat(Math.floor(current / total * 30)) + '░'.repeat(30 - Math.floor(current / total * 30));
  process.stdout.write(`\r${COLORS.dim}[${bar}]${COLORS.reset} ${pct}% (${current}/${total}) ${label}`);
  if (current === total) process.stdout.write('\n');
}

// ─── Cost Tracker ─────────────────────────────────────────────────────────────

// Sonnet 4.5 pricing (per million tokens)
const SONNET_INPUT_RATE = 3.00;
const SONNET_OUTPUT_RATE = 15.00;
const SONNET_CACHED_INPUT_RATE = 0.30; // 90% discount for cached prompts

export class CostTracker {
  constructor(budgetCap = 200) {
    this.budgetCap = budgetCap;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCachedTokens = 0;
    this.totalCost = 0;
    this.callCount = 0;
    this.warnings = new Set();
  }

  addCall({ inputTokens = 0, outputTokens = 0, cachedTokens = 0 }) {
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.totalCachedTokens += cachedTokens;
    this.callCount++;

    const uncachedInput = inputTokens - cachedTokens;
    const callCost =
      (uncachedInput / 1_000_000) * SONNET_INPUT_RATE +
      (cachedTokens / 1_000_000) * SONNET_CACHED_INPUT_RATE +
      (outputTokens / 1_000_000) * SONNET_OUTPUT_RATE;

    this.totalCost += callCost;

    // Budget warnings
    const pct = (this.totalCost / this.budgetCap) * 100;
    for (const threshold of [50, 75, 90]) {
      if (pct >= threshold && !this.warnings.has(threshold)) {
        this.warnings.add(threshold);
        logWarn(`BUDGET: ${threshold}% used — $${this.totalCost.toFixed(2)} of $${this.budgetCap}`);
      }
    }

    return callCost;
  }

  getSummary() {
    return {
      calls: this.callCount,
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      cachedTokens: this.totalCachedTokens,
      totalCost: this.totalCost,
      budgetRemaining: this.budgetCap - this.totalCost,
      budgetPct: ((this.totalCost / this.budgetCap) * 100).toFixed(1),
    };
  }

  print() {
    const s = this.getSummary();
    console.log('\n┌─────────────── Cost Summary ───────────────┐');
    console.log(`│ Calls:           ${String(s.calls).padStart(24)} │`);
    console.log(`│ Input tokens:    ${String(s.inputTokens.toLocaleString()).padStart(24)} │`);
    console.log(`│ Cached tokens:   ${String(s.cachedTokens.toLocaleString()).padStart(24)} │`);
    console.log(`│ Output tokens:   ${String(s.outputTokens.toLocaleString()).padStart(24)} │`);
    console.log(`│ Total cost:      ${('$' + s.totalCost.toFixed(2)).padStart(24)} │`);
    console.log(`│ Budget used:     ${(s.budgetPct + '%').padStart(24)} │`);
    console.log(`│ Budget remaining:${('$' + s.budgetRemaining.toFixed(2)).padStart(24)} │`);
    console.log('└────────────────────────────────────────────┘\n');
  }
}

// ─── Image Utilities ──────────────────────────────────────────────────────────

export function fileHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

export async function validateImage(filePath, minEdge = 200) {
  try {
    const meta = await sharp(filePath).metadata();
    if (!meta.width || !meta.height) return { valid: false, reason: 'no dimensions' };
    if (meta.width < minEdge || meta.height < minEdge) {
      return { valid: false, reason: `too small (${meta.width}x${meta.height})` };
    }
    return { valid: true, width: meta.width, height: meta.height, format: meta.format };
  } catch {
    return { valid: false, reason: 'unreadable' };
  }
}

export async function resizeForVision(inputPath, maxEdge = 1568) {
  const meta = await sharp(inputPath).metadata();
  if (meta.width <= maxEdge && meta.height <= maxEdge) {
    return fs.readFile(inputPath);
  }
  return sharp(inputPath)
    .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
    .toBuffer();
}

export function mimeFromExt(ext) {
  const map = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  return map[ext.toLowerCase()] || 'image/png';
}

// ─── General Utilities ────────────────────────────────────────────────────────

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function ensureDirs(...dirs) {
  for (const dir of dirs) {
    await fs.ensureDir(dir);
  }
}

export function sanitizeFilename(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80);
}

// ─── Promise Pool ─────────────────────────────────────────────────────────────

export async function promisePool(items, concurrency, fn) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ─── Project Paths ────────────────────────────────────────────────────────────

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

export const PATHS = {
  root: ROOT,
  config: path.join(ROOT, 'config'),
  data: path.join(ROOT, 'data'),
  screens: path.join(ROOT, 'data', 'screens'),
  analysis: path.join(ROOT, 'data', 'analysis'),
  synthesis: path.join(ROOT, 'data', 'synthesis'),
  briefs: path.join(ROOT, 'data', 'briefs'),
  outputLibrary: path.join(ROOT, 'output', 'library'),
  outputBriefs: path.join(ROOT, 'output', 'briefs'),
  patterns: path.join(ROOT, 'data', 'patterns'),
  outputPatternLibrary: path.join(ROOT, 'output', 'pattern-library'),
};
