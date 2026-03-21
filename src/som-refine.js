// SOM Refinement Layer — Delta diffing, structural signatures, exemplar matching,
// context assembly, and principle extraction.
//
// The Refinement Layer transforms wireframe-grade SOMs into polish-grade SOMs
// by learning from human corrections (before/after delta pairs). Claude Code
// performs the actual refinement in-session; this module provides the data
// infrastructure — diffing, matching, and context preparation.

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { deepClone } from './utils.js';
import { upgradeToV2, assignRolesTree, ROLE_CATEGORIES } from './som-roles.js';
import { cosineSimilarity, jaccardSimilarity } from './similarity.js';
import { TYPE_SCALE, GRID, snapToGrid, snapFontSize } from './som.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, '..', 'config');

// ─── Constants ──────────────────────────────────────────────────────────────

const ROLE_CATEGORY_KEYS = Object.keys(ROLE_CATEGORIES);

// Properties tracked in node deltas (style/layout values that affect polish)
const TRACKED_PROPERTIES = [
  'textStyle.fontSize', 'textStyle.fontWeight', 'textStyle.lineHeight',
  'textStyle.letterSpacing', 'textStyle.color', 'textStyle.textAlignHorizontal',
  'textStyle.textCase',
  'size.width', 'size.height',
  'cornerRadius',
  'autoLayout.spacing', 'autoLayout.direction',
  'autoLayout.padding.top', 'autoLayout.padding.right',
  'autoLayout.padding.bottom', 'autoLayout.padding.left',
  'autoLayout.primaryAxisAlign', 'autoLayout.counterAxisAlign',
  'autoLayout.primaryAxisSizing', 'autoLayout.counterAxisSizing',
  'layoutChild.alignSelf', 'layoutChild.grow', 'layoutChild.positioning',
  'strokeWeight', 'opacity',
  'iconRef',
];

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Get a nested property from an object using a dot-separated path. */
function getNestedValue(obj, path) {
  if (!obj) return undefined;
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

/** Compare two values for equality (handles objects and arrays shallowly). */
function valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/** Load Phosphor icon names from config. */
let _phosphorNames = null;
export function loadPhosphorIconNames() {
  if (_phosphorNames !== null) return _phosphorNames;
  try {
    const filePath = path.join(CONFIG_DIR, 'phosphor-icon-names.json');
    _phosphorNames = fs.readJsonSync(filePath);
  } catch {
    _phosphorNames = [];
  }
  return _phosphorNames;
}

/** Validate an iconRef value against the Phosphor name list. */
export function validateIconRef(iconRef) {
  if (!iconRef || typeof iconRef !== 'string') return { valid: false, reason: 'missing' };
  const match = iconRef.match(/^phosphor:(\w+)\/(thin|light|regular|bold|fill|duotone)\/(\d+)$/);
  if (!match) return { valid: false, reason: 'invalid format' };
  const [, name, weight, size] = match;
  const names = loadPhosphorIconNames();
  if (names.length > 0 && !names.includes(name)) {
    return { valid: false, reason: `unknown icon: ${name}`, name, weight, size: +size };
  }
  return { valid: true, name, weight, size: +size };
}

// ─── Node Delta Computation ─────────────────────────────────────────────────

/**
 * Walk a SOM tree and collect all nodes as a flat array with path info.
 * Each entry: { node, path, role, roleCategory, depth }
 */
function flattenTree(root) {
  const nodes = [];
  function walk(node, parentPath, depth) {
    const nodePath = parentPath || 'root';
    nodes.push({
      node,
      path: nodePath,
      role: node.role || 'unknown',
      roleCategory: node.roleCategory || null,
      name: node.name || '',
      depth,
    });
    if (Array.isArray(node.children)) {
      node.children.forEach((child, i) => {
        walk(child, `${nodePath}.children[${i}]`, depth + 1);
      });
    }
  }
  walk(root, 'root', 0);
  return nodes;
}

/**
 * Match nodes between two SOM trees.
 * Strategy: same index + same role (preferred), then same name (fallback).
 * Returns { matched, usedAfterPaths }.
 */
function matchNodes(beforeFlat, afterFlat) {
  const matched = [];
  const usedAfterPaths = new Set();
  const matchedBeforePaths = new Set();

  // Build indexes for O(1) lookup
  const afterByPathRole = new Map();
  for (const a of afterFlat) {
    afterByPathRole.set(`${a.path}|${a.role}`, a);
  }

  const afterByNameRole = new Map();
  for (const a of afterFlat) {
    if (a.name) {
      const key = `${a.name}|${a.role}`;
      if (!afterByNameRole.has(key)) afterByNameRole.set(key, a);
    }
  }

  // Pass 1: match by path + role
  for (const bEntry of beforeFlat) {
    const aEntry = afterByPathRole.get(`${bEntry.path}|${bEntry.role}`);
    if (aEntry && !usedAfterPaths.has(aEntry.path)) {
      matched.push({
        beforeNode: bEntry.node,
        afterNode: aEntry.node,
        path: bEntry.path,
        role: bEntry.role,
        roleCategory: bEntry.roleCategory,
      });
      usedAfterPaths.add(aEntry.path);
      matchedBeforePaths.add(bEntry.path);
    }
  }

  // Pass 2: unmatched by path, try matching by name + role
  for (const bEntry of beforeFlat) {
    if (matchedBeforePaths.has(bEntry.path)) continue;
    if (!bEntry.name) continue;
    const aEntry = afterByNameRole.get(`${bEntry.name}|${bEntry.role}`);
    if (aEntry && !usedAfterPaths.has(aEntry.path)) {
      matched.push({
        beforeNode: bEntry.node,
        afterNode: aEntry.node,
        path: bEntry.path,
        role: bEntry.role,
        roleCategory: bEntry.roleCategory,
      });
      usedAfterPaths.add(aEntry.path);
      matchedBeforePaths.add(bEntry.path);
    }
  }

  return { matched, usedAfterPaths, matchedBeforePaths };
}

/**
 * Compute node-level deltas between two SOMs.
 * Both SOMs should be v2 (with roles assigned).
 * Returns: { node_deltas: [...], unmatched_before: [...], unmatched_after: [...] }
 */
export function computeNodeDeltas(beforeSOM, afterSOM) {
  // Only clone if we need to mutate (assign roles)
  const needsRolesB = !beforeSOM.version || beforeSOM.version < 2;
  const needsRolesA = !afterSOM.version || afterSOM.version < 2;
  const bRoot = needsRolesB ? deepClone(beforeSOM).root : beforeSOM.root;
  const aRoot = needsRolesA ? deepClone(afterSOM).root : afterSOM.root;

  if (needsRolesB) assignRolesTree(bRoot);
  if (needsRolesA) assignRolesTree(aRoot);

  const beforeFlat = flattenTree(bRoot);
  const afterFlat = flattenTree(aRoot);
  const { matched, usedAfterPaths, matchedBeforePaths } = matchNodes(beforeFlat, afterFlat);

  const node_deltas = [];

  for (const { beforeNode, afterNode, path, role, roleCategory } of matched) {
    const changes = {};

    for (const prop of TRACKED_PROPERTIES) {
      const bVal = getNestedValue(beforeNode, prop);
      const aVal = getNestedValue(afterNode, prop);

      if (!valuesEqual(bVal, aVal) && (bVal !== undefined || aVal !== undefined)) {
        changes[prop] = { before: bVal ?? null, after: aVal ?? null };
      }
    }

    // Also check fills color changes (first fill only for simplicity)
    const bFillColor = beforeNode.fills?.[0]?.color;
    const aFillColor = afterNode.fills?.[0]?.color;
    if (bFillColor !== aFillColor && (bFillColor || aFillColor)) {
      changes['fills[0].color'] = { before: bFillColor ?? null, after: aFillColor ?? null };
    }

    if (Object.keys(changes).length > 0) {
      node_deltas.push({ node_path: path, role, roleCategory, changes });
    }
  }

  const unmatched_before = beforeFlat
    .filter(b => !matchedBeforePaths.has(b.path))
    .map(b => ({ path: b.path, role: b.role, name: b.name }));

  const unmatched_after = afterFlat
    .filter(a => !usedAfterPaths.has(a.path))
    .map(a => ({ path: a.path, role: a.role, name: a.name }));

  return { node_deltas, unmatched_before, unmatched_after };
}

// ─── Structural Signature ───────────────────────────────────────────────────

/**
 * Build a lightweight structural fingerprint for a SOM.
 * Used for fast exemplar matching without loading full SOMs.
 */
export function buildStructuralSignature(som) {
  // Only clone if we need to mutate (assign roles)
  const needsRoles = !som.version || som.version < 2;
  const root = needsRoles ? deepClone(som).root : som.root;
  if (needsRoles) assignRolesTree(root);

  const role_sequence = [];
  const category_counts = {};
  let maxDepth = 0;
  let nodeCount = 0;

  // Initialize category counts
  for (const key of ROLE_CATEGORY_KEYS) {
    category_counts[key] = 0;
  }

  function walk(node, depth) {
    nodeCount++;
    if (depth > maxDepth) maxDepth = depth;

    if (node.role && node.role !== 'unknown') {
      // Only top-level roles in the sequence (depth <= 2)
      if (depth <= 2) {
        role_sequence.push(node.role);
      }
      if (node.roleCategory && category_counts[node.roleCategory] !== undefined) {
        category_counts[node.roleCategory]++;
      }
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    }
  }

  walk(root, 0);

  return {
    role_sequence,
    depth: maxDepth,
    node_count: nodeCount,
    category_counts,
  };
}

// ─── Exemplar Matching ──────────────────────────────────────────────────────

/** Convert role_distribution/category_counts to a vector for cosine similarity. */
function categoryCountsToVector(counts) {
  return ROLE_CATEGORY_KEYS.map(k => counts[k] || 0);
}

/**
 * Find the best matching exemplar deltas for a target screen.
 *
 * @param {object} targetContext - Screen context (screen_type, layout_type, design_mood, style_tags)
 * @param {object} targetSignature - Structural signature from buildStructuralSignature()
 * @param {Array} allDeltas - Array of delta documents from MongoDB
 * @param {object} options - { top: 3, minScore: 0.2 }
 * @returns {Array} - Scored and ranked deltas: [{ delta, score, breakdown }]
 */
export function findBestExemplars(targetContext, targetSignature, allDeltas, options = {}) {
  const { top = 3, minScore = 0.2 } = options;

  if (!allDeltas || allDeltas.length === 0) return [];

  const targetCategoryVec = categoryCountsToVector(targetSignature.category_counts);

  const scored = allDeltas.map(delta => {
    const ctx = delta.context || {};
    const sig = delta.structural_signature || {};

    // 1. Screen type match (0.30)
    const screenTypeScore = ctx.screen_type === targetContext.screen_type ? 1.0 : 0.0;

    // 2. Structural similarity (0.30)
    const deltaCategoryVec = categoryCountsToVector(sig.category_counts || {});
    const cosineScore = cosineSimilarity(targetCategoryVec, deltaCategoryVec);
    const roleJaccard = jaccardSimilarity(
      targetSignature.role_sequence,
      sig.role_sequence || []
    );
    const structuralScore = 0.6 * cosineScore + 0.4 * roleJaccard;

    // 3. Mood/style match (0.20)
    const tagJaccard = jaccardSimilarity(
      targetContext.style_tags || [],
      ctx.style_tags || []
    );
    const moodMatch = ctx.design_mood === targetContext.design_mood ? 1.0 : 0.0;
    const moodScore = 0.5 * tagJaccard + 0.5 * moodMatch;

    // 4. Layout match (0.10)
    const layoutScore = ctx.layout_type === targetContext.layout_type ? 1.0 : 0.0;

    // 5. Recency (0.10)
    const ageMs = Date.now() - new Date(delta.created_at || 0).getTime();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const recencyScore = Math.exp(-ageMs / THIRTY_DAYS_MS);

    const total = 0.30 * screenTypeScore
      + 0.30 * structuralScore
      + 0.20 * moodScore
      + 0.10 * layoutScore
      + 0.10 * recencyScore;

    return {
      delta,
      score: +total.toFixed(4),
      breakdown: {
        screenType: +screenTypeScore.toFixed(2),
        structural: +structuralScore.toFixed(2),
        mood: +moodScore.toFixed(2),
        layout: +layoutScore.toFixed(2),
        recency: +recencyScore.toFixed(2),
      },
    };
  });

  return scored
    .filter(s => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}

// ─── Refinement Context Assembly ────────────────────────────────────────────

/**
 * Build the complete refinement context for a screen.
 * This is what the MCP tool returns to Claude Code.
 *
 * @param {object} store - The Store instance
 * @param {string} screenId - Screen ID
 * @param {object} options - { maxExemplars: 3 }
 * @returns {object} - Complete refinement context
 */
export async function buildRefinementContext(store, screenId, options = {}) {
  const { maxExemplars = 3 } = options;

  // 1. Get raw SOM and screen metadata in parallel
  const [somDoc, screen] = await Promise.all([
    store.getScreenSOM(screenId),
    store.getScreen(screenId),
  ]);
  if (!somDoc?.som) return { error: `No SOM found for screen ${screenId}` };
  if (!screen) return { error: `Screen ${screenId} not found` };
  const som = somDoc.som;

  const screenContext = {
    screen_type: screen.analysis?.screen_type || 'unknown',
    layout_type: screen.fingerprint?.layout_type || 'unknown',
    design_mood: screen.fingerprint?.design_mood || 'unknown',
    style_tags: screen.fingerprint?.style_tags || [],
    platform: screen.analysis?.platform || 'unknown',
    scores: screen.analysis?.scores || {},
  };

  // 3. Build structural signature
  const signature = buildStructuralSignature(som);

  // 4. Find best exemplars and applicable principles in parallel
  const [allDeltas, principles] = await Promise.all([
    store.getDeltas({
      $or: [
        { 'context.screen_type': screenContext.screen_type },
        {
          'context.design_mood': screenContext.design_mood,
          'context.layout_type': screenContext.layout_type,
        },
      ],
    }),
    store.getPrinciples({
      status: 'confirmed',
      $or: [
        { 'conditions.screen_type': screenContext.screen_type },
        { 'conditions.screen_type': null },
        { 'conditions.screen_type': { $exists: false } },
      ],
    }),
  ]);

  const exemplars = findBestExemplars(screenContext, signature, allDeltas, {
    top: maxExemplars,
  });

  // 6. Load Phosphor icon names
  const phosphorIconNames = loadPhosphorIconNames();

  return {
    raw_som: som,
    screen_context: screenContext,
    structural_signature: signature,
    exemplars: exemplars.map(e => ({
      context: e.delta.context,
      node_deltas: e.delta.node_deltas,
      score: e.score,
      breakdown: e.breakdown,
    })),
    principles: principles.map(p => ({
      text: p.text,
      status: p.status,
      evidence_count: p.evidence_count,
      conditions: p.conditions,
    })),
    phosphor_icon_names: phosphorIconNames,
    meta: {
      exemplars_found: exemplars.length,
      principles_found: principles.length,
      mode: exemplars.length === 0 ? 'cold_start' : exemplars.length < 3 ? 'partial' : 'matched',
    },
  };
}

// ─── Principle Extraction ───────────────────────────────────────────────────

/**
 * Extract refinement principles from accumulated deltas.
 * Groups deltas by (screen_type, role, property), computes direction consistency
 * and value convergence. Emits confirmed/tentative principles.
 *
 * @param {Array} deltas - All delta documents
 * @param {object} options - { minEvidence: 3, confirmThreshold: 0.80, tentativeThreshold: 0.60 }
 * @returns {Array} - Extracted principles
 */
export function extractPrinciples(deltas, options = {}) {
  const {
    minEvidence = 3,
    confirmThreshold = 0.80,
    tentativeThreshold = 0.60,
  } = options;

  // Group changes by (screen_type, role, property)
  const groups = new Map();

  for (const delta of deltas) {
    const screenType = delta.context?.screen_type || 'unknown';

    for (const nd of (delta.node_deltas || [])) {
      for (const [prop, change] of Object.entries(nd.changes || {})) {
        const key = `${screenType}|${nd.role}|${nd.roleCategory}|${prop}`;
        if (!groups.has(key)) {
          groups.set(key, {
            screen_type: screenType,
            role: nd.role,
            roleCategory: nd.roleCategory,
            property: prop,
            changes: [],
          });
        }
        groups.get(key).changes.push(change);
      }
    }
  }

  const principles = [];

  for (const [, group] of groups) {
    if (group.changes.length < minEvidence) continue;

    const { changes, screen_type, role, roleCategory, property } = group;

    // Analyze direction consistency
    let increaseCount = 0;
    let decreaseCount = 0;
    let setToCount = 0;
    const afterValues = [];

    for (const change of changes) {
      const { before, after } = change;

      if (typeof before === 'number' && typeof after === 'number') {
        if (after > before) increaseCount++;
        else if (after < before) decreaseCount++;
        afterValues.push(after);
      } else if (typeof after === 'string' || typeof after === 'number') {
        setToCount++;
        afterValues.push(after);
      }
    }

    const total = changes.length;
    const dominantDirection = increaseCount >= decreaseCount && increaseCount >= setToCount
      ? 'increase'
      : decreaseCount >= increaseCount && decreaseCount >= setToCount
        ? 'decrease'
        : 'set_to';

    const dominantCount = dominantDirection === 'increase' ? increaseCount
      : dominantDirection === 'decrease' ? decreaseCount
        : setToCount;

    const consistency = dominantCount / total;

    if (consistency < tentativeThreshold) continue;

    // Compute target value (median for numbers, mode for strings)
    let targetValue = null;
    const numericAfters = afterValues.filter(v => typeof v === 'number');
    if (numericAfters.length > 0) {
      numericAfters.sort((a, b) => a - b);
      targetValue = numericAfters[Math.floor(numericAfters.length / 2)];
    } else {
      // Mode for non-numeric
      const counts = {};
      for (const v of afterValues) {
        const key = String(v);
        counts[key] = (counts[key] || 0) + 1;
      }
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      targetValue = sorted[0]?.[0] ?? null;
    }

    // Generate description text
    let text;
    if (dominantDirection === 'increase' && typeof targetValue === 'number') {
      text = `${screen_type} ${role}: ${property} should be ~${targetValue} (increase)`;
    } else if (dominantDirection === 'decrease' && typeof targetValue === 'number') {
      text = `${screen_type} ${role}: ${property} should be ~${targetValue} (decrease)`;
    } else {
      text = `${screen_type} ${role}: ${property} should be ${targetValue}`;
    }

    const status = consistency >= confirmThreshold ? 'confirmed' : 'tentative';

    principles.push({
      text,
      status,
      evidence_count: total,
      conditions: {
        screen_type,
        role,
        roleCategory,
      },
      property,
      direction: dominantDirection,
      target_value: targetValue,
      consistency: +consistency.toFixed(2),
      contradictions: 0,
      created_at: new Date(),
      last_validated: new Date(),
    });
  }

  return principles;
}
