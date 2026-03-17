// SOM Roles — Role taxonomy, auto-detection, and v1→v2 upgrade
//
// v2 SOM nodes get `role`, `roleCategory`, `content`, and `style` fields
// added alongside existing flat properties (backward-compatible).

import { deepClone } from './utils.js';

// ─── Role Categories (7) ────────────────────────────────────────────────────

export const ROLE_CATEGORIES = {
  structure:   { mergeRule: 'style_only',       description: 'Layout skeleton (nav bars, tab bars)' },
  hero:        { mergeRule: 'layout_style',     description: 'Primary visual area' },
  content:     { mergeRule: 'structure_style',   description: 'Information blocks (cards, sections, rows)' },
  interactive: { mergeRule: 'styling_style',     description: 'Buttons, inputs, toggles' },
  decorative:  { mergeRule: 'style_only',       description: 'Visual elements (dividers, icons, badges)' },
  feedback:    { mergeRule: 'template_style',    description: 'State indicators (toasts, modals, banners)' },
  data:        { mergeRule: 'values_content',    description: 'Pure text/numbers' },
};

// ─── Role Definitions (~35) ─────────────────────────────────────────────────
// patterns: matched case-insensitively against node.name (kebab-case)
// Prefix patterns end with '-' to match e.g. "frame-main"

export const ROLES = {
  // Structure
  screen:       { category: 'structure',   patterns: ['screen', 'root', 'page', 'frame-'] },
  nav:          { category: 'structure',   patterns: ['nav', 'nav-bar', 'header', 'top-bar', 'navigation'] },
  'bottom-nav': { category: 'structure',   patterns: ['bottom-nav', 'tab-bar', 'footer-nav'] },
  'status-bar': { category: 'structure',   patterns: ['status-bar', 'system-bar'] },
  'tab-bar':    { category: 'structure',   patterns: ['tabs', 'segment', 'switcher'] },

  // Hero
  hero:           { category: 'hero', patterns: ['hero', 'hero-section', 'gradient-header', 'banner-hero'] },
  'header-image': { category: 'hero', patterns: ['header-image', 'cover', 'splash'] },
  carousel:       { category: 'hero', patterns: ['carousel', 'slider', 'stories'] },

  // Content
  card:        { category: 'content', patterns: ['card', 'card-'] },
  section:     { category: 'content', patterns: ['section', '-section', 'content-', 'details-'] },
  row:         { category: 'content', patterns: ['row', 'row-', '-row'] },
  list:        { category: 'content', patterns: ['list', '-list', 'quick-actions', 'features-'] },
  'list-item': { category: 'content', patterns: ['list-item', 'action-', 'feature-'] },
  accordion:   { category: 'content', patterns: ['accordion', 'expandable', 'collapsible'] },

  // Interactive
  cta:             { category: 'interactive', patterns: ['cta', 'cta-button', '-btn', 'send-btn', 'confirm-'] },
  'cta-secondary': { category: 'interactive', patterns: ['cta-secondary', 'outline-btn', 'price-comparison-'] },
  input:           { category: 'interactive', patterns: ['input', 'search-bar', 'text-field', 'amount-'] },
  toggle:          { category: 'interactive', patterns: ['toggle', 'switch'] },
  checkbox:        { category: 'interactive', patterns: ['checkbox', 'check'] },
  'swipe-cta':     { category: 'interactive', patterns: ['swipe-', 'slide-'] },
  fab:             { category: 'interactive', patterns: ['fab', 'floating-'] },

  // Decorative
  divider: { category: 'decorative', patterns: ['divider', 'div', 'separator', 'line'] },
  pill:    { category: 'decorative', patterns: ['pill', 'chip', 'badge', 'tag', 'accounts-pill'] },
  icon:    { category: 'decorative', patterns: ['icon', 'icon-'] },
  avatar:  { category: 'decorative', patterns: ['avatar', 'profile-pic', 'user-image'] },

  // Feedback
  toast:         { category: 'feedback', patterns: ['toast', 'snackbar'] },
  modal:         { category: 'feedback', patterns: ['modal', 'dialog', 'popup'] },
  'bottom-sheet': { category: 'feedback', patterns: ['bottom-sheet', 'sheet'] },
  'empty-state': { category: 'feedback', patterns: ['empty-state', 'no-data'] },
  banner:        { category: 'feedback', patterns: ['banner', 'verify-', 'alert', 'notification-card'] },
  progress:      { category: 'feedback', patterns: ['progress', 'stepper', 'step-'] },
  skeleton:      { category: 'feedback', patterns: ['skeleton', 'shimmer', 'loading'] },

  // Data
  label:  { category: 'data', patterns: ['label', '-label', 'metric-label'] },
  value:  { category: 'data', patterns: ['value', '-value', 'amount-', 'balance-'] },
  prompt: { category: 'data', patterns: ['prompt', 'safety-', 'warning-body', '-body'] },
  chart:  { category: 'data', patterns: ['chart', 'graph', 'data-viz'] },
};

// ─── Pattern Matching ───────────────────────────────────────────────────────

// Build a sorted lookup: longer patterns first for specificity
const PATTERN_INDEX = [];
for (const [role, def] of Object.entries(ROLES)) {
  for (const pattern of def.patterns) {
    PATTERN_INDEX.push({ pattern: pattern.toLowerCase(), role, category: def.category });
  }
}
PATTERN_INDEX.sort((a, b) => b.pattern.length - a.pattern.length);

function normalizeName(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/[\s_]/g, '-');
}

function matchPattern(normalized, pattern) {
  // Prefix pattern (ends with '-'): match start
  if (pattern.endsWith('-')) {
    return normalized.startsWith(pattern) || normalized === pattern.slice(0, -1);
  }
  // Suffix pattern (starts with '-'): match end
  if (pattern.startsWith('-')) {
    return normalized.endsWith(pattern) || normalized === pattern.slice(1);
  }
  // Exact or contains
  return normalized === pattern || normalized.includes(pattern);
}

// ─── Auto-Detection ─────────────────────────────────────────────────────────

export function assignRole(node, parentHeight) {
  if (!node || typeof node !== 'object') return { role: 'unknown', roleCategory: null, confidence: 0 };

  const normalized = normalizeName(node.name);

  // 1. Name-based matching (sorted by specificity)
  for (const entry of PATTERN_INDEX) {
    if (matchPattern(normalized, entry.pattern)) {
      // Longer/exact matches get higher confidence
      const conf = normalized === entry.pattern ? 1.0
        : entry.pattern.length >= 6 ? 0.95
        : 0.9;
      return { role: entry.role, roleCategory: entry.category, confidence: conf };
    }
  }

  // 2. Heuristic fallbacks
  if (node.type === 'ELLIPSE') {
    const w = node.size?.width || 0;
    return w > 30
      ? { role: 'avatar', roleCategory: 'decorative', confidence: 0.7 }
      : { role: 'icon', roleCategory: 'decorative', confidence: 0.7 };
  }

  if (node.type === 'TEXT' && (!node.children || node.children.length === 0)) {
    const fontSize = node.textStyle?.fontSize || 14;
    return fontSize >= 20
      ? { role: 'value', roleCategory: 'data', confidence: 0.6 }
      : { role: 'label', roleCategory: 'data', confidence: 0.6 };
  }

  if (node.type === 'LINE') {
    return { role: 'divider', roleCategory: 'decorative', confidence: 0.8 };
  }

  // Position-based: bottom of screen → bottom-nav candidate
  if (parentHeight && node.position?.y > parentHeight - 80 && node.type === 'FRAME') {
    return { role: 'bottom-nav', roleCategory: 'structure', confidence: 0.6 };
  }

  // Gradient fill → hero candidate
  if (Array.isArray(node.fills) && node.fills.some(f => f.type === 'GRADIENT_LINEAR' || f.type === 'GRADIENT_RADIAL')) {
    return { role: 'hero', roleCategory: 'hero', confidence: 0.5 };
  }

  return { role: 'unknown', roleCategory: null, confidence: 0 };
}

// Walk a SOM tree, calling assignRole on each node and invoking an optional
// visitor(node, role, roleCategory, confidence) at every step.
export function walkAndAssignRoles(rootNode, visitor) {
  function walk(node, parentHeight) {
    const { role, roleCategory, confidence } = assignRole(node, parentHeight);
    node.role = role;
    node.roleCategory = roleCategory;

    if (visitor) visitor(node, role, roleCategory, confidence);

    if (Array.isArray(node.children)) {
      const h = node.size?.height || parentHeight;
      for (const child of node.children) {
        walk(child, h);
      }
    }
  }

  walk(rootNode, rootNode.size?.height || 730);
}

export function assignRolesTree(rootNode) {
  const roleMap = [];
  const unknowns = [];
  let totalConfidence = 0;
  let nodeCount = 0;

  walkAndAssignRoles(rootNode, (node, role, roleCategory, confidence) => {
    roleMap.push({ node_name: node.name, role, category: roleCategory, confidence });
    totalConfidence += confidence;
    nodeCount++;
    if (role === 'unknown') unknowns.push(node.name);
  });

  return {
    root: rootNode,
    roleMap,
    unknowns,
    confidence: nodeCount > 0 ? +(totalConfidence / nodeCount).toFixed(2) : 0,
  };
}

// ─── Content / Style Separation ─────────────────────────────────────────────

const STYLE_KEYS = new Set([
  'fills', 'strokes', 'effects', 'opacity', 'cornerRadius', 'strokeWeight',
  'autoLayout', 'textStyle', 'clipContent', 'blendMode',
]);

const META_KEYS = new Set([
  'type', 'name', 'role', 'roleCategory', 'children',
  'content', 'style', 'size', 'position',
  'isComponent', 'instanceCount', 'imageRole',
]);

export function separateContentStyle(node) {
  if (!node || typeof node !== 'object') return { content: {}, style: {} };

  const content = {};
  const style = {};

  // TEXT nodes: text value is content, everything else is style
  if (node.type === 'TEXT') {
    content.text = node.characters || node.name || '';
    // textStyle goes to style
    if (node.textStyle) style.textStyle = node.textStyle;
    if (node.fills) style.fills = node.fills;
    if (typeof node.opacity === 'number') style.opacity = node.opacity;
  }
  // RECTANGLE / ELLIPSE / LINE: purely decorative, all style
  else if (node.type === 'RECTANGLE' || node.type === 'ELLIPSE' || node.type === 'LINE') {
    for (const [k, v] of Object.entries(node)) {
      if (!META_KEYS.has(k)) style[k] = v;
    }
  }
  // FRAME: extract text from children as content, layout/visual as style
  else if (node.type === 'FRAME') {
    // Collect text content from direct TEXT children
    const texts = [];
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        if (child.type === 'TEXT') {
          texts.push(child.characters || child.name || '');
        }
      }
    }
    if (texts.length > 0) content.texts = texts;

    // All visual/layout properties go to style
    for (const [k, v] of Object.entries(node)) {
      if (STYLE_KEYS.has(k)) style[k] = v;
    }
  }

  return { content, style };
}

// ─── v1 → v2 Upgrade ───────────────────────────────────────────────────────

export function upgradeToV2(som) {
  const upgraded = deepClone(som);
  upgraded.version = 2;

  if (upgraded.root) {
    walkAndAssignRoles(upgraded.root, (node) => {
      const { content, style } = separateContentStyle(node);
      if (Object.keys(content).length > 0) node.content = content;
      if (Object.keys(style).length > 0) node.style = style;
    });
  }

  return upgraded;
}
