import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
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

// ─── Brand Extraction ─────────────────────────────────────────────────────────

export function extractBrand(screenId) {
  const m = screenId.match(/^(.+?)_\d+$/);
  return m ? m[1] : screenId;
}

export function brandDisplayName(slug) {
  if (!slug) return '';
  if (slug.length <= 3) return slug.toUpperCase();
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
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

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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

// ─── Shared Constants ────────────────────────────────────────────────────────

export const CLAUDE_MODEL = 'claude-sonnet-4-5-20250929';

export const IMAGE_EXT_RE = /\.(jpg|jpeg|png|gif|webp)$/i;

export const SCORE_FIELDS = {
  core: [
    'color_restraint', 'hierarchy_clarity', 'glanceability', 'density',
    'whitespace_ratio', 'brand_confidence', 'calm_confident', 'bold_forward',
    'overall_quality',
  ],
  spectrum: [
    'calm_energetic', 'confident_tentative', 'forward_conservative',
    'premium_accessible', 'warm_clinical',
  ],
};

// ─── CLI Argument Parser ─────────────────────────────────────────────────────

export function parseFlags() {
  const args = process.argv.slice(2);
  const flags = {};
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, val] = arg.slice(2).split('=');
      flags[key] = val || true;
    }
  }

  const industryFilter = flags.industry
    ? flags.industry.split(',').map(s => s.trim())
    : null;

  return { flags, industryFilter };
}

// ─── Industry Discovery ──────────────────────────────────────────────────────

const SPECIAL_FOLDERS = ['gcash_current', 'curated'];

export async function loadIndustries(industryFilter = null, baseDir = PATHS.screens) {
  const config = await fs.readJson(path.join(PATHS.config, 'industries.json'));
  let industries = config.industries.map(i => i.id);

  for (const special of SPECIAL_FOLDERS) {
    if (await fs.pathExists(path.join(baseDir, special))) {
      if (!industries.includes(special)) industries.push(special);
    }
  }

  if (industryFilter) {
    industries = industries.filter(id => industryFilter.includes(id));
  }

  return industries;
}

export async function loadIndustryObjects(industryFilter = null, baseDir = PATHS.screens) {
  const config = await fs.readJson(path.join(PATHS.config, 'industries.json'));
  let industries = industryFilter
    ? config.industries.filter(i => industryFilter.includes(i.id))
    : [...config.industries];

  for (const special of SPECIAL_FOLDERS) {
    const dir = path.join(baseDir, special);
    if (await fs.pathExists(dir) && (!industryFilter || industryFilter.includes(special))) {
      if (!industries.find(i => i.id === special)) {
        industries.push({ id: special, name: special.replace(/_/g, ' ') });
      }
    }
  }

  return industries;
}

// ─── JSON Response Parsing ───────────────────────────────────────────────────

export function parseJsonResponse(text, shape = 'object') {
  try {
    return JSON.parse(text);
  } catch {
    const re = shape === 'array' ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
    const match = text.match(re);
    if (match) return JSON.parse(match[0]);
    throw new Error('Invalid JSON response');
  }
}
