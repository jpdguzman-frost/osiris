// Screen Object Model (SOM) — Validation, Post-Processing & Scaling
//
// SOM generation happens in Claude Code sessions (vision model analyzes the screenshot).
// This module provides utilities for validating, cleaning, and scaling the resulting JSON.

const TYPE_SCALE = [10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64];
const GRID = 4;
const VALID_NODE_TYPES = new Set(['FRAME', 'TEXT', 'RECTANGLE', 'ELLIPSE', 'LINE']);
const HEX_RE = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function snapToGrid(value) {
  return Math.round(value / GRID) * GRID;
}

function snapFontSize(size) {
  let closest = TYPE_SCALE[0];
  let minDiff = Math.abs(size - closest);
  for (const s of TYPE_SCALE) {
    const diff = Math.abs(size - s);
    if (diff < minDiff) {
      minDiff = diff;
      closest = s;
    }
  }
  return closest;
}

function fixColor(color) {
  if (!color || typeof color !== 'string') return null;
  const m3 = color.match(/^#([0-9A-Fa-f])([0-9A-Fa-f])([0-9A-Fa-f])$/);
  if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`;
  if (HEX_RE.test(color)) return color;
  return null;
}

// ─── Post-Processing ──────────────────────────────────────────────────────────

function postProcessNode(node) {
  if (!node || typeof node !== 'object') return node;

  if (node.size) {
    if (typeof node.size.width === 'number') node.size.width = snapToGrid(node.size.width);
    if (typeof node.size.height === 'number') node.size.height = snapToGrid(node.size.height);
  }

  if (node.position) {
    if (typeof node.position.x === 'number') node.position.x = snapToGrid(node.position.x);
    if (typeof node.position.y === 'number') node.position.y = snapToGrid(node.position.y);
  }

  if (typeof node.cornerRadius === 'number') {
    node.cornerRadius = snapToGrid(node.cornerRadius);
  } else if (node.cornerRadius && typeof node.cornerRadius === 'object') {
    for (const k of ['topLeft', 'topRight', 'bottomRight', 'bottomLeft']) {
      if (typeof node.cornerRadius[k] === 'number') node.cornerRadius[k] = snapToGrid(node.cornerRadius[k]);
    }
  }

  if (typeof node.strokeWeight === 'number' && node.strokeWeight > 0) {
    node.strokeWeight = Math.max(1, Math.round(node.strokeWeight));
  }

  if (node.autoLayout) {
    const al = node.autoLayout;
    if (typeof al.spacing === 'number') al.spacing = snapToGrid(al.spacing);
    if (al.padding) {
      for (const k of ['top', 'right', 'bottom', 'left']) {
        if (typeof al.padding[k] === 'number') al.padding[k] = snapToGrid(al.padding[k]);
      }
    }
  }

  if (Array.isArray(node.fills)) {
    node.fills = node.fills.map(f => {
      if (f.color) f.color = fixColor(f.color) || f.color;
      if (f.stops) f.stops = f.stops.map(s => ({ ...s, color: fixColor(s.color) || s.color }));
      return f;
    }).filter(f => f.type);
  }

  if (Array.isArray(node.strokes)) {
    node.strokes = node.strokes.map(f => {
      if (f.color) f.color = fixColor(f.color) || f.color;
      return f;
    }).filter(f => f.type);
  }

  if (Array.isArray(node.effects)) {
    node.effects = node.effects.map(e => {
      if (e.color) e.color = fixColor(e.color) || e.color;
      if (typeof e.blur === 'number') e.blur = snapToGrid(e.blur);
      return e;
    });
  }

  if (node.textStyle) {
    const ts = node.textStyle;
    if (typeof ts.fontSize === 'number') ts.fontSize = snapFontSize(ts.fontSize);
    if (typeof ts.lineHeight === 'number') ts.lineHeight = snapToGrid(ts.lineHeight);
    if (ts.color) ts.color = fixColor(ts.color) || ts.color;
  }

  if (typeof node.opacity === 'number') {
    node.opacity = Math.max(0, Math.min(1, node.opacity));
  }

  for (const key of Object.keys(node)) {
    if (node[key] === null || node[key] === undefined) delete node[key];
  }

  if (Array.isArray(node.children)) {
    node.children = node.children.map(postProcessNode).filter(Boolean);
  }

  return node;
}

// ─── Validation ──────────────────────────────────────────────────────────────

export function validateSOM(som) {
  const errors = [];

  if (!som.referenceFrame) errors.push('Missing referenceFrame');
  if (!som.root) errors.push('Missing root node');
  if (som.root && som.root.type !== 'FRAME') errors.push(`Root type must be FRAME, got: ${som.root.type}`);

  function walkNode(node, nodePath) {
    if (!node.type) {
      errors.push(`${nodePath}: Missing type`);
    } else if (!VALID_NODE_TYPES.has(node.type)) {
      errors.push(`${nodePath}: Invalid type "${node.type}"`);
    }
    if (Array.isArray(node.children)) {
      node.children.forEach((child, i) => walkNode(child, `${nodePath}.children[${i}]`));
    }
  }

  if (som.root) walkNode(som.root, 'root');

  return { valid: errors.length === 0, errors };
}

// ─── Prepare SOM for Storage ─────────────────────────────────────────────────

export function prepareSOM(som) {
  // Ensure required metadata
  if (!som.referenceFrame) som.referenceFrame = { width: 356, height: 730 };
  if (!som.version) som.version = 1;

  // Post-process: snap to grid, fix colors, strip nulls
  if (som.root) som.root = postProcessNode(som.root);

  return som;
}

// ─── SOM Scaling ─────────────────────────────────────────────────────────────

export function scaleSOM(som, targetWidth, targetHeight) {
  const scaled = JSON.parse(JSON.stringify(som));
  const scale = targetWidth / scaled.referenceFrame.width;

  function scaleNode(node) {
    if (node.size) {
      if (typeof node.size.width === 'number') node.size.width = snapToGrid(node.size.width * scale);
      if (typeof node.size.height === 'number') node.size.height = snapToGrid(node.size.height * scale);
    }

    if (node.position) {
      if (typeof node.position.x === 'number') node.position.x = snapToGrid(node.position.x * scale);
      if (typeof node.position.y === 'number') node.position.y = snapToGrid(node.position.y * scale);
    }

    if (typeof node.cornerRadius === 'number') {
      node.cornerRadius = snapToGrid(node.cornerRadius * scale);
    } else if (node.cornerRadius && typeof node.cornerRadius === 'object') {
      for (const k of ['topLeft', 'topRight', 'bottomRight', 'bottomLeft']) {
        if (typeof node.cornerRadius[k] === 'number') node.cornerRadius[k] = snapToGrid(node.cornerRadius[k] * scale);
      }
    }

    if (typeof node.strokeWeight === 'number' && node.strokeWeight > 0) {
      node.strokeWeight = Math.max(1, Math.round(node.strokeWeight * scale));
    }

    if (node.autoLayout) {
      const al = node.autoLayout;
      if (typeof al.spacing === 'number') al.spacing = snapToGrid(al.spacing * scale);
      if (al.padding) {
        for (const k of ['top', 'right', 'bottom', 'left']) {
          if (typeof al.padding[k] === 'number') al.padding[k] = snapToGrid(al.padding[k] * scale);
        }
      }
    }

    if (node.textStyle) {
      const ts = node.textStyle;
      if (typeof ts.fontSize === 'number') ts.fontSize = snapFontSize(ts.fontSize * scale);
      if (typeof ts.lineHeight === 'number') ts.lineHeight = snapToGrid(ts.lineHeight * scale);
      if (typeof ts.letterSpacing === 'number') ts.letterSpacing = Math.round(ts.letterSpacing * scale * 100) / 100;
    }

    if (Array.isArray(node.effects)) {
      for (const e of node.effects) {
        if (typeof e.blur === 'number') e.blur = snapToGrid(e.blur * scale);
        if (typeof e.spread === 'number') e.spread = snapToGrid(e.spread * scale);
        if (e.offset) {
          if (typeof e.offset.x === 'number') e.offset.x = snapToGrid(e.offset.x * scale);
          if (typeof e.offset.y === 'number') e.offset.y = snapToGrid(e.offset.y * scale);
        }
      }
    }

    if (Array.isArray(node.children)) {
      node.children.forEach(scaleNode);
    }
  }

  if (scaled.root) scaleNode(scaled.root);
  scaled.referenceFrame = { width: targetWidth, height: targetHeight };

  return scaled;
}
