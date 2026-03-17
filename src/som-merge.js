// SOM Merge — Merge two SOMs: content from one, style from another
//
// Given a content SOM and a style SOM (both v2 with roles),
// produces a merged SOM using category-specific merge rules.

import { ROLE_CATEGORIES, upgradeToV2 } from './som-roles.js';
import { deepClone, walkTree } from './utils.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function collectRolesAndCategories(node) {
  const roles = new Map();
  const categories = new Map();
  walkTree(node, (n) => {
    if (n.role && n.role !== 'unknown') {
      if (!roles.has(n.role)) roles.set(n.role, []);
      roles.get(n.role).push(n);
    }
    if (n.roleCategory) {
      if (!categories.has(n.roleCategory)) categories.set(n.roleCategory, []);
      categories.get(n.roleCategory).push(n);
    }
  });
  return { roles, categories };
}

// Replace text content in a style node using content from a content node.
// Walks both trees in parallel by position, replacing TEXT node values.
// IMPORTANT: Mutates styleNode in place — caller must pass a clone if needed.
function injectTextContent(styleNode, contentNode) {
  // Collect text from content tree
  const contentTexts = [];
  walkTree(contentNode, (node) => {
    if (node.type === 'TEXT') {
      contentTexts.push(node.content?.text || node.characters || node.name || '');
    }
  });

  // Replace text in style tree
  let textIdx = 0;
  walkTree(styleNode, (node) => {
    if (node.type === 'TEXT' && textIdx < contentTexts.length) {
      node.characters = contentTexts[textIdx];
      if (node.content) node.content.text = contentTexts[textIdx];
      node.name = contentTexts[textIdx].slice(0, 30).replace(/\s+/g, '-').toLowerCase() || node.name;
      textIdx++;
    }
  });

  return styleNode;
}

function indexByName(root) {
  const map = new Map();
  walkTree(root, (node) => {
    if (node.name) map.set(node.name, node);
  });
  return map;
}

// ─── Category-Specific Merge Functions ──────────────────────────────────────

// NOTE: All merge functions receive nodes from already-cloned trees (cSOM/sSOM),
// so they mutate in place rather than cloning again.

function mergeStructure(contentNode, styleNode) {
  // Style SOM only — ignore content entirely
  return styleNode;
}

// Inject text from content into style node (used by hero and feedback)
function mergeTextOnly(contentNode, styleNode) {
  return injectTextContent(styleNode, contentNode);
}

function mergeContent(contentNode, styleNode, options) {
  const overflow = options.overflow || 'repeat_pattern';
  const underflow = options.underflow || 'hide_extra';
  const overflows = [];

  // Replace text content at the top level
  if (contentNode.content) styleNode.content = contentNode.content;

  // Handle children (list items, rows, etc.)
  const styleChildren = styleNode.children || [];
  const contentChildren = contentNode.children || [];
  const originalSlotCount = styleChildren.length;

  if (contentChildren.length > styleChildren.length && styleChildren.length > 0) {
    // Overflow: more content items than style slots
    if (overflow === 'repeat_pattern') {
      const template = styleChildren[styleChildren.length - 1];
      for (let i = styleChildren.length; i < contentChildren.length; i++) {
        const clone = deepClone(template);
        clone.name = `${template.name}-${i}`;
        styleChildren.push(clone);
      }
    }
    overflows.push({
      role: contentNode.role,
      content_items: contentChildren.length,
      style_slots: originalSlotCount,
      resolution: overflow,
    });
    styleNode.children = styleChildren;
  } else if (contentChildren.length < styleChildren.length) {
    // Underflow: fewer content items than style slots
    if (underflow === 'hide_extra') {
      styleNode.children = styleChildren.slice(0, contentChildren.length);
    }
    // placeholder: keep all, text stays as-is
  }

  // Inject content text into each matched child
  const finalChildren = styleNode.children || [];
  for (let i = 0; i < Math.min(finalChildren.length, contentChildren.length); i++) {
    injectTextContent(finalChildren[i], contentChildren[i]);
  }

  return { node: styleNode, overflows };
}

// Copy content object then inject text (used by interactive and data)
function mergeWithContent(contentNode, styleNode) {
  if (contentNode.content) styleNode.content = contentNode.content;
  return injectTextContent(styleNode, contentNode);
}

const MERGE_FN = {
  structure: mergeStructure,
  hero: mergeTextOnly,
  content: null,  // handled specially (returns overflows)
  interactive: mergeWithContent,
  decorative: mergeStructure,  // style SOM only, same as structure
  feedback: mergeTextOnly,
  data: mergeWithContent,
};

// ─── Main Merge ─────────────────────────────────────────────────────────────

export function mergeSOM(contentSOM, styleSOM, mapping = 'auto', options = {}) {
  // 1. Ensure both are v2
  const cSOM = (!contentSOM.version || contentSOM.version < 2) ? upgradeToV2(contentSOM) : deepClone(contentSOM);
  const sSOM = (!styleSOM.version || styleSOM.version < 2) ? upgradeToV2(styleSOM) : deepClone(styleSOM);

  // 2. Build role indexes (single pass per tree)
  const { roles: contentRoles } = collectRolesAndCategories(cSOM.root);
  const { roles: styleRoles, categories: styleCategories } = collectRolesAndCategories(sSOM.root);

  // 3. Match nodes
  const matches = [];       // [{ contentNode, styleNode, role, category }]
  const unmatchedContent = [];
  const unmatchedStyle = new Set([...styleRoles.keys()]);

  if (mapping === 'auto') {
    for (const [role, contentNodes] of contentRoles) {
      // Skip root screen node — it's the container, not a mergeable component
      if (role === 'screen') {
        unmatchedStyle.delete(role);
        continue;
      }
      if (styleRoles.has(role)) {
        // Exact role match
        unmatchedStyle.delete(role);
        const styleNodes = styleRoles.get(role);
        for (let i = 0; i < contentNodes.length; i++) {
          const styleNode = styleNodes[i % styleNodes.length];
          matches.push({
            contentNode: contentNodes[i],
            styleNode,
            role,
            category: contentNodes[i].roleCategory,
          });
        }
      } else {
        // Try category fallback
        const cat = contentNodes[0]?.roleCategory;
        if (cat && styleCategories.has(cat)) {
          const styleCatNodes = styleCategories.get(cat);
          // Find first style node in this category that hasn't been matched
          let found = false;
          for (const sn of styleCatNodes) {
            if (unmatchedStyle.has(sn.role)) {
              unmatchedStyle.delete(sn.role);
              for (let i = 0; i < contentNodes.length; i++) {
                matches.push({
                  contentNode: contentNodes[i],
                  styleNode: sn,
                  role: contentNodes[i].role,
                  category: cat,
                });
              }
              found = true;
              break;
            }
          }
          if (!found) {
            for (const cn of contentNodes) unmatchedContent.push(cn.name || cn.role);
          }
        } else {
          for (const cn of contentNodes) unmatchedContent.push(cn.name || cn.role);
        }
      }
    }
  } else if (typeof mapping === 'object') {
    // Custom mapping: { contentNodeName: styleNodeName }
    const styleByName = indexByName(sSOM.root);
    const contentByName = indexByName(cSOM.root);

    for (const [cName, sName] of Object.entries(mapping)) {
      const cn = contentByName.get(cName);
      const sn = styleByName.get(sName);
      if (cn && sn) {
        matches.push({ contentNode: cn, styleNode: sn, role: cn.role, category: cn.roleCategory });
        unmatchedStyle.delete(sn.role);
      }
    }
  }

  // 4. Merge each matched pair
  const mergedChildren = [];
  const allOverflows = [];
  const reviewItems = [];

  for (const { contentNode, styleNode, role, category } of matches) {
    if (!category || !ROLE_CATEGORIES[category]) {
      mergedChildren.push(styleNode);
      reviewItems.push(`${role}: unknown category "${category}", used style node as-is`);
      continue;
    }

    if (category === 'content') {
      const { node, overflows } = mergeContent(contentNode, styleNode, options);
      mergedChildren.push(node);
      allOverflows.push(...overflows);
      for (const o of overflows) {
        reviewItems.push(`${role} overflow: ${o.content_items} items vs ${o.style_slots} slots — ${o.resolution}`);
      }
    } else {
      const fn = MERGE_FN[category];
      if (fn) {
        mergedChildren.push(fn(contentNode, styleNode));
      } else {
        mergedChildren.push(styleNode);
      }
    }
  }

  // 5. Handle unmatched nodes
  for (const name of unmatchedContent) {
    reviewItems.push(`${name} (content) has no match in style SOM — appended at end`);
  }
  const unmatchedStyleNames = [...unmatchedStyle].filter(r => r !== 'screen');
  for (const role of unmatchedStyleNames) {
    reviewItems.push(`${role} (style) has no matching content — kept with original content`);
  }

  // Append unmatched content nodes with generic styling
  for (const name of unmatchedContent) {
    for (const [, nodes] of contentRoles) {
      for (const node of nodes) {
        if ((node.name || node.role) === name) {
          mergedChildren.push(node);
        }
      }
    }
  }

  // Append unmatched style nodes with placeholder content
  for (const role of unmatchedStyleNames) {
    if (styleRoles.has(role)) {
      for (const node of styleRoles.get(role)) {
        mergedChildren.push(node);
      }
    }
  }

  // 6. Assemble merged SOM (sSOM is already a clone, safe to mutate)
  const mergedRoot = sSOM.root;
  mergedRoot.children = mergedChildren;
  // Carry content metadata
  mergedRoot.content = cSOM.root.content;

  const merged_som = {
    referenceFrame: options.target_width && options.target_height
      ? { width: options.target_width, height: options.target_height }
      : sSOM.referenceFrame || cSOM.referenceFrame,
    screenType: cSOM.screenType || sSOM.screenType,
    platform: cSOM.platform || sSOM.platform,
    version: 2,
    root: mergedRoot,
  };

  // 7. Build report
  const confidence = matches.length > 0
    ? +((matches.length / (matches.length + unmatchedContent.length + unmatchedStyleNames.length)) * 100) / 100
    : 0;

  const report = {
    matched_roles: matches.length,
    unmatched_content: unmatchedContent,
    unmatched_style: unmatchedStyleNames,
    overflows: allOverflows,
    confidence: +confidence.toFixed(2),
    needs_review: unmatchedContent.length > 0 || unmatchedStyleNames.length > 0 || allOverflows.length > 0,
    review_items: reviewItems,
  };

  return { merged_som, report };
}
