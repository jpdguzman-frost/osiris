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
