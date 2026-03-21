// ─── Refinement Filter — Adversarial Classification + Pattern Extraction ─────
//
// Classifies raw refinement record changes into 6 categories (intentional,
// noise, cascade, exploratory, content, structural) and extracts reusable
// property patterns from the intentional changes.

// ─── Noise Thresholds ────────────────────────────────────────────────────────

const NOISE_THRESHOLDS = {
  x: 1,
  y: 1,
  width: 1,
  height: 1,
  opacity: 0.01,
  fontSize: 0.5,
  cornerRadius: 0.5,
  strokeWeight: 0.5,
  itemSpacing: 1,
  paddingTop: 1,
  paddingRight: 1,
  paddingBottom: 1,
  paddingLeft: 1,
};

const LAYOUT_PROPERTIES = new Set([
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'itemSpacing', 'layoutMode', 'primaryAxisAlignItems', 'counterAxisAlignItems',
  'layoutSizingHorizontal', 'layoutSizingVertical',
]);

const POSITION_PROPERTIES = new Set(['x', 'y']);

const CONTENT_PROPERTIES = new Set(['characters', 'textContent']);

// ─── Classification ─────────────────────────────────────────────────────────

/**
 * Classify each change in a set of refinement records.
 * Mutates each change object by adding `classification` and `classificationReason`.
 *
 * @param {Array} records - Array of refinement record documents from MongoDB
 * @returns {{ records: Array, summary: Object }}
 */
export function classifyChanges(records) {
  const summary = { total: 0, intentional: 0, noise: 0, cascade: 0, exploratory: 0, content: 0, structural: 0 };

  // Build cross-record oscillation map: (nodeId:property) → [values]
  const valueHistory = new Map();
  for (const record of records) {
    for (const change of record.changes) {
      const key = change.nodeId + ':' + change.property;
      if (!valueHistory.has(key)) valueHistory.set(key, []);
      valueHistory.get(key).push({ from: change.from, to: change.to, recordId: record._id });
    }
  }

  // Detect oscillating keys
  const oscillatingKeys = new Set();
  for (const [key, history] of valueHistory) {
    if (detectOscillation(history)) {
      oscillatingKeys.add(key);
    }
  }

  // Classify each change
  for (const record of records) {
    // Check if this batch contains any layout property changes
    const batchHasLayoutChange = record.changes.some(c => LAYOUT_PROPERTIES.has(c.property));

    for (const change of record.changes) {
      summary.total++;

      // Priority 1: Root frame position changes (canvas repositioning)
      if (change.nodeId === record.frameId && POSITION_PROPERTIES.has(change.property)) {
        classify(change, 'noise', 'root_frame_reposition');
        summary.noise++;
        continue;
      }

      // Priority 2: Sub-threshold noise
      const threshold = NOISE_THRESHOLDS[change.property];
      if (threshold !== undefined && isNumeric(change.from) && isNumeric(change.to)) {
        if (Math.abs(change.to - change.from) < threshold) {
          classify(change, 'noise', 'sub_threshold');
          summary.noise++;
          continue;
        }
      }

      // Priority 3: Content changes
      if (CONTENT_PROPERTIES.has(change.property)) {
        classify(change, 'content', 'text_content');
        summary.content++;
        continue;
      }

      // Priority 4: Cascade — position change in a batch with layout changes
      if (POSITION_PROPERTIES.has(change.property) && batchHasLayoutChange) {
        // Only cascade if this node isn't the one making the layout change
        const nodeIsLayoutChanger = record.changes.some(
          c => c.nodeId === change.nodeId && LAYOUT_PROPERTIES.has(c.property)
        );
        if (!nodeIsLayoutChanger) {
          classify(change, 'cascade', 'autolayout_cascade');
          summary.cascade++;
          continue;
        }
      }

      // Priority 5: Exploratory — value oscillation across records
      const key = change.nodeId + ':' + change.property;
      if (oscillatingKeys.has(key)) {
        classify(change, 'exploratory', 'value_oscillation');
        summary.exploratory++;
        continue;
      }

      // Priority 6: Everything else is intentional
      classify(change, 'intentional', 'design_decision');
      summary.intentional++;
    }
  }

  return { records, summary };
}

// ─── Pattern Extraction ─────────────────────────────────────────────────────

/**
 * Extract property patterns from classified refinement records.
 * Only processes changes classified as 'intentional'.
 *
 * @param {Array} classifiedRecords - Records with classified changes
 * @param {Array} existingPatterns - Existing patterns from DB for merging
 * @returns {Array} Pattern objects ready for upsert
 */
export function extractPatterns(classifiedRecords, existingPatterns = []) {
  // Build lookup of existing patterns by key
  const existingMap = new Map();
  for (const p of existingPatterns) {
    existingMap.set(p.role + ':' + p.property + ':' + (p.brandId || ''), p);
  }

  // Collect processed record IDs from existing patterns
  const processedIds = new Set();
  for (const p of existingPatterns) {
    if (p.sourceRecordIds) {
      for (const id of p.sourceRecordIds) {
        processedIds.add(String(id));
      }
    }
  }

  // Group intentional changes by (role, property, brandId)
  const groups = new Map();
  for (const record of classifiedRecords) {
    const recordId = String(record._id);
    if (processedIds.has(recordId)) continue; // Skip already-processed records

    for (const change of record.changes) {
      if (change.classification !== 'intentional') continue;

      const key = change.role + ':' + change.property + ':' + (record.brandId || '');
      if (!groups.has(key)) {
        groups.set(key, {
          role: change.role,
          property: change.property,
          brandId: record.brandId || null,
          screenType: record.screenType || null,
          values: [],
          sourceRecordIds: [],
        });
      }
      const group = groups.get(key);
      group.values.push(change.to);
      if (!group.sourceRecordIds.includes(recordId)) {
        group.sourceRecordIds.push(recordId);
      }
    }
  }

  // Build pattern objects
  const patterns = [];
  for (const [key, group] of groups) {
    if (group.values.length === 0) continue;

    // Merge with existing pattern if one exists
    const existing = existingMap.get(key);
    const allValues = existing ? [...existing.values, ...group.values] : group.values;
    const allRecordIds = existing
      ? [...(existing.sourceRecordIds || []).map(String), ...group.sourceRecordIds]
      : group.sourceRecordIds;

    const modeValue = computeMode(allValues);
    const consistency = computeConsistency(allValues, modeValue);
    const direction = computeDirection(allValues);
    const occurrences = allValues.length;
    const status = computeStatus(occurrences, consistency);

    patterns.push({
      role: group.role,
      property: group.property,
      brandId: group.brandId,
      screenType: group.screenType,
      values: allValues,
      modeValue,
      consistency,
      direction,
      occurrences,
      status,
      sourceRecordIds: [...new Set(allRecordIds)],
      firstSeenAt: existing?.firstSeenAt || new Date(),
      lastSeenAt: new Date(),
    });
  }

  return patterns;
}

// ─── Template Pattern Extraction ────────────────────────────────────────────

/** Style properties worth extracting from SOM nodes (skip positional). */
const TEMPLATE_PROPERTIES = new Set([
  'fill', 'cornerRadius', 'opacity', 'strokeWeight', 'clipsContent',
  'gap', 'padding',
  'fontSize', 'fontFamily', 'fontWeight', 'textAlign', 'letterSpacing', 'lineHeight',
]);

/**
 * Default values to ignore during template extraction.
 * These represent Rex's built-in defaults, not designer choices.
 */
const DEFAULT_VALUES = {
  fontFamily: new Set(['Inter']),
  fill: new Set(['#FFFFFF', '#ffffff']),
  clipsContent: new Set([true]),
  gap: new Set([0]),
  paddingTop: new Set([0]),
  paddingRight: new Set([0]),
  paddingBottom: new Set([0]),
  paddingLeft: new Set([0]),
  opacity: new Set([1]),
  cornerRadius: new Set([0]),
  strokeWeight: new Set([0, 1]),
  textAlign: new Set(['LEFT']),
};

function isDefaultValue(property, value) {
  const defaults = DEFAULT_VALUES[property];
  if (!defaults) return false;
  return defaults.has(value);
}

/**
 * Extract cross-brand patterns from reference template SOMs.
 * Walks each template's node tree, groups style values by (role, property),
 * and produces patterns with brandId: null (universal designer preferences).
 */
export function extractPatternsFromTemplates(templates, existingPatterns = []) {
  // Group values by (role, property) across all templates
  const groups = new Map();

  for (const template of templates) {
    if (!template.som?.root) continue;
    walkSomNode(template.som.root, groups, template._id);
  }

  // Build existing lookup for merging
  const existingMap = new Map();
  for (const p of existingPatterns) {
    if (p.brandId === null) {
      existingMap.set(p.role + ':' + p.property, p);
    }
  }

  // Build pattern objects
  const patterns = [];
  for (const [key, group] of groups) {
    if (group.values.length < 2) continue; // Need at least 2 occurrences across templates

    const existing = existingMap.get(key);
    const allValues = existing ? [...existing.values, ...group.values] : group.values;

    const modeValue = computeMode(allValues);
    const consistency = computeConsistency(allValues, modeValue);
    const direction = computeDirection(allValues);
    const occurrences = allValues.length;
    const status = computeStatus(occurrences, consistency);

    patterns.push({
      role: group.role,
      property: group.property,
      brandId: null,
      screenType: null,
      values: allValues,
      modeValue,
      consistency,
      direction,
      occurrences,
      status,
      source: 'template',
      sourceRecordIds: [...new Set(group.templateIds)],
      firstSeenAt: existing?.firstSeenAt || new Date(),
      lastSeenAt: new Date(),
    });
  }

  return patterns;
}

/** Recursively walk a SOM node tree, extracting style properties by role. */
function walkSomNode(node, groups, templateId) {
  if (!node.role || node.role === 'screen' || node.role === 'unknown') {
    // Skip root screen and unknown roles, but still walk children
    if (node.children) {
      for (const child of node.children) walkSomNode(child, groups, templateId);
    }
    return;
  }

  const style = node.style || {};

  for (const prop of TEMPLATE_PROPERTIES) {
    let value = style[prop];
    if (value === undefined || value === null) continue;

    // Expand padding object to individual sides
    if (prop === 'padding') {
      if (typeof value === 'number') {
        addToGroup(groups, node.role, 'paddingTop', value, templateId);
        addToGroup(groups, node.role, 'paddingRight', value, templateId);
        addToGroup(groups, node.role, 'paddingBottom', value, templateId);
        addToGroup(groups, node.role, 'paddingLeft', value, templateId);
      } else if (typeof value === 'object') {
        if (value.top !== undefined) addToGroup(groups, node.role, 'paddingTop', value.top, templateId);
        if (value.right !== undefined) addToGroup(groups, node.role, 'paddingRight', value.right, templateId);
        if (value.bottom !== undefined) addToGroup(groups, node.role, 'paddingBottom', value.bottom, templateId);
        if (value.left !== undefined) addToGroup(groups, node.role, 'paddingLeft', value.left, templateId);
      }
      continue;
    }

    // Normalize letterSpacing/lineHeight objects to just the value
    if ((prop === 'letterSpacing' || prop === 'lineHeight') && typeof value === 'object') {
      value = value.value;
      if (value === undefined || value === 0) continue;
    }

    addToGroup(groups, node.role, prop, value, templateId);
  }

  // Walk children
  if (node.children) {
    for (const child of node.children) walkSomNode(child, groups, templateId);
  }
}

function addToGroup(groups, role, property, value, templateId) {
  // Skip default values — they reflect Rex's defaults, not designer choices
  if (isDefaultValue(property, value)) return;

  const key = role + ':' + property;
  if (!groups.has(key)) {
    groups.set(key, { role, property, values: [], templateIds: [] });
  }
  const group = groups.get(key);
  group.values.push(value);
  if (!group.templateIds.includes(String(templateId))) {
    group.templateIds.push(String(templateId));
  }
}

// ─── Style Guide Extraction ─────────────────────────────────────────────────

/**
 * Extract a natural-language design principles document from reference templates.
 * Analyzes typography, spacing, radii, and color patterns across all templates
 * and produces a structured guide that Claude reads as design context.
 */
export function extractStyleGuide(templates) {
  // Collect raw data from all templates
  const groups = new Map();
  const templateMeta = [];

  for (const template of templates) {
    if (!template.som?.root) continue;
    walkSomNode(template.som.root, groups, template._id);
    templateMeta.push({
      id: template._id,
      brand: template.brandId,
      screenType: template.screenType,
      screenSubtype: template.screenSubtype,
    });
  }

  // Also collect data INCLUDING defaults for full picture
  const allGroups = new Map();
  for (const template of templates) {
    if (!template.som?.root) continue;
    walkSomNodeFull(template.som.root, allGroups, template._id);
  }

  // Synthesize principles
  const typography = synthesizeTypography(groups, allGroups);
  const spacing = synthesizeSpacing(groups, allGroups);
  const radii = synthesizeRadii(groups, allGroups);
  const colors = synthesizeColors(groups, allGroups);

  return {
    generatedAt: new Date().toISOString(),
    templateCount: templateMeta.length,
    brands: [...new Set(templateMeta.map(t => t.brand))],
    principles: {
      typography,
      spacing,
      radii,
      colors,
    },
    // Natural language summary for Claude to read
    summary: generateSummary(typography, spacing, radii, colors, templateMeta),
  };
}

/** Walk SOM without default filtering — captures the full picture. */
function walkSomNodeFull(node, groups, templateId) {
  if (!node.role || node.role === 'screen' || node.role === 'unknown') {
    if (node.children) {
      for (const child of node.children) walkSomNodeFull(child, groups, templateId);
    }
    return;
  }
  const style = node.style || {};
  for (const prop of TEMPLATE_PROPERTIES) {
    let value = style[prop];
    if (value === undefined || value === null) continue;
    if (prop === 'padding') {
      if (typeof value === 'number') {
        addToGroupRaw(groups, node.role, 'paddingTop', value);
        addToGroupRaw(groups, node.role, 'paddingRight', value);
        addToGroupRaw(groups, node.role, 'paddingBottom', value);
        addToGroupRaw(groups, node.role, 'paddingLeft', value);
      } else if (typeof value === 'object') {
        if (value.top !== undefined) addToGroupRaw(groups, node.role, 'paddingTop', value.top);
        if (value.right !== undefined) addToGroupRaw(groups, node.role, 'paddingRight', value.right);
        if (value.bottom !== undefined) addToGroupRaw(groups, node.role, 'paddingBottom', value.bottom);
        if (value.left !== undefined) addToGroupRaw(groups, node.role, 'paddingLeft', value.left);
      }
      continue;
    }
    if ((prop === 'letterSpacing' || prop === 'lineHeight') && typeof value === 'object') {
      value = value.value;
      if (value === undefined) continue;
    }
    addToGroupRaw(groups, node.role, prop, value);
  }
  if (node.children) {
    for (const child of node.children) walkSomNodeFull(child, groups, templateId);
  }
}

function addToGroupRaw(groups, role, property, value) {
  const key = role + ':' + property;
  if (!groups.has(key)) groups.set(key, { role, property, values: [] });
  groups.get(key).values.push(value);
}

function getValues(groups, role, prop) {
  const g = groups.get(role + ':' + prop);
  return g ? g.values : [];
}

function mode(values) {
  if (values.length === 0) return null;
  return computeMode(values);
}

function unique(values) {
  return [...new Set(values.map(v => typeof v === 'object' ? JSON.stringify(v) : v))];
}

// ── Synthesizers ──────────────────────────────────────────────────────────

function synthesizeTypography(groups, allGroups) {
  const roles = ['heading', 'label', 'value', 'nav', 'cta', 'section'];
  const result = {};

  for (const role of roles) {
    const families = getValues(allGroups, role, 'fontFamily');
    const weights = getValues(allGroups, role, 'fontWeight');
    const sizes = getValues(allGroups, role, 'fontSize');
    const spacing = getValues(allGroups, role, 'letterSpacing');
    const lineHeights = getValues(allGroups, role, 'lineHeight');

    if (families.length === 0 && weights.length === 0) continue;

    result[role] = {};
    if (families.length > 0) result[role].preferredFont = mode(families);
    if (weights.length > 0) result[role].preferredWeight = mode(weights);
    if (sizes.length > 0) result[role].sizeRange = { min: Math.min(...sizes), max: Math.max(...sizes), typical: mode(sizes) };
    if (spacing.length > 0) result[role].letterSpacing = mode(spacing);
    if (lineHeights.length > 0) result[role].lineHeight = mode(lineHeights);
    result[role].sampleCount = Math.max(families.length, weights.length, sizes.length);
  }

  return result;
}

function synthesizeSpacing(groups, allGroups) {
  // Collect all gap and padding values by role
  const roles = ['section', 'card', 'row', 'nav', 'cta', 'content-group', 'heading'];
  const result = {};

  for (const role of roles) {
    const gaps = getValues(allGroups, role, 'gap');
    const padT = getValues(allGroups, role, 'paddingTop');
    const padR = getValues(allGroups, role, 'paddingRight');
    const padB = getValues(allGroups, role, 'paddingBottom');
    const padL = getValues(allGroups, role, 'paddingLeft');

    if (gaps.length === 0 && padT.length === 0) continue;

    result[role] = {};
    if (gaps.length > 0) result[role].gap = { typical: mode(gaps), range: unique(gaps) };
    if (padT.length > 0) {
      result[role].padding = {
        vertical: mode(padT),
        horizontal: mode(padR.length > 0 ? padR : padL),
        verticalRange: unique(padT),
        horizontalRange: unique(padR),
      };
    }
  }

  // Detect grid system
  const allSpacingValues = [];
  for (const [, g] of allGroups) {
    if (['gap', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].includes(g.property)) {
      allSpacingValues.push(...g.values.filter(v => typeof v === 'number' && v > 0));
    }
  }
  const gridBase = detectGrid(allSpacingValues);

  result._gridBase = gridBase;
  result._spacingScale = gridBase ? [...new Set(allSpacingValues)].filter(v => v % gridBase === 0).sort((a, b) => a - b) : [];

  return result;
}

function detectGrid(values) {
  if (values.length < 4) return 8; // default
  // Check if most values are divisible by 4 or 8
  const div8 = values.filter(v => v % 8 === 0).length / values.length;
  const div4 = values.filter(v => v % 4 === 0).length / values.length;
  if (div8 > 0.7) return 8;
  if (div4 > 0.7) return 4;
  return 8;
}

function synthesizeRadii(groups, allGroups) {
  const roles = ['card', 'cta', 'input', 'nav', 'section', 'icon', 'bottom-nav', 'pill', 'icon-bg'];
  const result = {};

  for (const role of roles) {
    const radii = getValues(allGroups, role, 'cornerRadius');
    if (radii.length === 0) continue;
    const nonZero = radii.filter(v => typeof v === 'number' && v > 0);
    if (nonZero.length === 0) continue;
    result[role] = { typical: mode(nonZero), range: unique(nonZero), sampleCount: nonZero.length };
  }

  return result;
}

function synthesizeColors(groups, allGroups) {
  // Collect fill colors by role
  const textRoles = ['heading', 'label', 'value', 'cta', 'nav'];
  const result = { textColors: {}, approach: [] };

  for (const role of textRoles) {
    const fills = getValues(allGroups, role, 'fill');
    if (fills.length === 0) continue;
    const colorFills = fills.filter(v => typeof v === 'string' && v.startsWith('#'));
    if (colorFills.length === 0) continue;
    result.textColors[role] = { typical: mode(colorFills), variations: unique(colorFills) };
  }

  // Infer approach
  result.approach = [
    'Colors should be derived from the source screen palette, not prescribed.',
    'Extract dominant, accent, and neutral colors from the reference screenshot.',
    'Primary text uses the darkest available color from the palette.',
    'Secondary/body text uses a softer tone (~60-80% opacity or mid-gray).',
    'The designer tends to remove unnecessary white fills from containers.',
  ];

  return result;
}

// ── Summary Generator ─────────────────────────────────────────────────────

function generateSummary(typography, spacing, radii, colors, meta) {
  const lines = [];
  const brands = [...new Set(meta.map(t => t.brand))];

  lines.push(`Design principles extracted from ${meta.length} refined screens across ${brands.length} brands (${brands.join(', ')}).`);
  lines.push('');

  // Typography
  lines.push('## Typography');
  for (const [role, data] of Object.entries(typography)) {
    const parts = [];
    if (data.preferredFont) parts.push(data.preferredFont);
    if (data.preferredWeight) parts.push(`weight ${data.preferredWeight}`);
    if (data.sizeRange) parts.push(`${data.sizeRange.min}-${data.sizeRange.max}px (typical ${data.sizeRange.typical}px)`);
    if (data.letterSpacing) parts.push(`letter-spacing ${data.letterSpacing}%`);
    if (data.lineHeight) parts.push(`line-height ${data.lineHeight}%`);
    lines.push(`- **${role}**: ${parts.join(', ')} (${data.sampleCount} samples)`);
  }
  lines.push('');

  // Spacing
  lines.push('## Spacing');
  if (spacing._gridBase) lines.push(`- Grid base: ${spacing._gridBase}px`);
  if (spacing._spacingScale.length > 0) lines.push(`- Scale: ${spacing._spacingScale.join(', ')}px`);
  for (const [role, data] of Object.entries(spacing)) {
    if (role.startsWith('_')) continue;
    const parts = [];
    if (data.gap) parts.push(`gap ${data.gap.typical}px`);
    if (data.padding) parts.push(`padding V:${data.padding.vertical}px H:${data.padding.horizontal}px`);
    lines.push(`- **${role}**: ${parts.join(', ')}`);
  }
  lines.push('');

  // Radii
  lines.push('## Corner Radius');
  lines.push('Radii are proportional to element size. Infer the relationship from these observed values:');
  for (const [role, data] of Object.entries(radii)) {
    lines.push(`- **${role}**: ${data.typical}px typical (range: ${data.range.join(', ')}px, ${data.sampleCount} samples)`);
  }
  lines.push('');

  // Colors
  lines.push('## Color Approach');
  for (const line of colors.approach) {
    lines.push(`- ${line}`);
  }
  lines.push('');
  lines.push('Observed text color patterns (for reference, not prescription):');
  for (const [role, data] of Object.entries(colors.textColors)) {
    lines.push(`- **${role}**: typically ${data.typical} (${data.variations.length} variation${data.variations.length > 1 ? 's' : ''})`);
  }

  return lines.join('\n');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function classify(change, classification, reason) {
  change.classification = classification;
  change.classificationReason = reason;
}

function isNumeric(v) {
  return typeof v === 'number' && !isNaN(v);
}

/**
 * Detect value oscillation in a change history.
 * Returns true if a value appears, changes, then returns to a previous value.
 */
function detectOscillation(history) {
  if (history.length < 2) return false;
  const seen = new Set();
  seen.add(serialize(history[0].from));
  for (const entry of history) {
    const toKey = serialize(entry.to);
    if (seen.has(toKey)) return true;
    seen.add(toKey);
  }
  return false;
}

function serialize(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Compute the mode (most common value) of an array. */
function computeMode(values) {
  const counts = new Map();
  for (const v of values) {
    const key = serialize(v);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let maxCount = 0;
  let modeKey = null;
  for (const [key, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      modeKey = key;
    }
  }
  // Return the original value, not the serialized key
  for (const v of values) {
    if (serialize(v) === modeKey) return v;
  }
  return values[0];
}

/** Compute consistency: how often the mode value appears. */
function computeConsistency(values, modeValue) {
  if (values.length === 0) return 0;
  const modeKey = serialize(modeValue);
  const modeCount = values.filter(v => serialize(v) === modeKey).length;
  return Math.round((modeCount / values.length) * 100) / 100;
}

/** Compute direction trend for numeric values. */
function computeDirection(values) {
  const nums = values.filter(isNumeric);
  if (nums.length < 2) return 'stable';
  const first = nums[0];
  const last = nums[nums.length - 1];
  const diff = last - first;
  const range = Math.max(...nums) - Math.min(...nums);
  if (range === 0) return 'stable';
  // Need at least 20% of range to call a direction
  if (diff > range * 0.2) return 'increase';
  if (diff < -range * 0.2) return 'decrease';
  return 'stable';
}

/** Compute lifecycle status from occurrence count and consistency. */
function computeStatus(occurrences, consistency) {
  if (occurrences >= 5 && consistency >= 0.8) return 'confirmed';
  if (occurrences >= 3 && consistency >= 0.6) return 'candidate';
  return 'observed';
}
