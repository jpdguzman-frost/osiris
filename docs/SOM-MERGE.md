# SOM Merge/Adapt Specification

## Overview

SOM Merge enables adapting existing screen designs to new visual languages by separating **content** from **style** at the structural level. Given two SOMs — a content source and a style source — the system produces a merged SOM that carries the data/meaning from one screen and the visual treatment from another.

This was validated manually on 2026-03-17 in a session where GCash review screen content was successfully adapted to Revolut card-based style, Fuse gradient style, and dark-to-light theme translation — all by hand. This spec formalizes that process.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                     Claude (AI)                      │
│  • Validates role assignments                        │
│  • Resolves merge conflicts                          │
│  • Judges overflow / underflow                       │
│  • Reviews merge report before build                 │
├──────────────────────┬──────────────────────────────┤
│    Osiris (Server)   │       Rex (Figma MCP)         │
│  • Stores SOMs       │  • Extracts SOMs from Figma   │
│  • Assigns roles     │  • Builds merged SOM on canvas│
│  • Merges SOMs       │  • Screenshots for validation │
│  • Returns reports   │  • Instances components        │
└──────────────────────┴──────────────────────────────┘
```

### Responsibility Split

| Concern | Owner | Reason |
|---|---|---|
| SOM storage & retrieval | Osiris | Already handles screen data |
| Role auto-assignment | Osiris | Server-side, no Figma needed |
| SOM merge logic | Osiris | JSON→JSON transform, no Figma needed |
| Merge validation | Claude | Requires design judgment |
| SOM extraction from Figma | Rex | Needs Figma plugin API access |
| Building merged SOM on canvas | Rex | Needs Figma plugin API access |
| Role correction/override | Claude + Osiris | AI suggests, Osiris stores |

---

## 1. SOM Node Anatomy

### Current SOM Node (v1)
```json
{
  "type": "FRAME",
  "name": "verify-card",
  "w": 350,
  "h": 168,
  "fill": "#2A1F4D",
  "cornerRadius": 16,
  "layout": "VERTICAL",
  "padding": 20,
  "gap": 12,
  "children": [...]
}
```

### Extended SOM Node (v2 — with roles)
```json
{
  "type": "FRAME",
  "name": "verify-card",
  "role": "banner",
  "roleCategory": "feedback",
  "w": 350,
  "h": 168,
  "content": {
    "title": "Verify your identity",
    "body": "Keep your account safe and unlock the full Revolut experience",
    "action": "Submit documents"
  },
  "style": {
    "fill": "#2A1F4D",
    "cornerRadius": 16,
    "layout": "VERTICAL",
    "padding": 20,
    "gap": 12
  },
  "children": [...]
}
```

### Key Changes from v1 to v2:
1. **`role`** — semantic role tag (e.g., "banner", "cta", "hero")
2. **`roleCategory`** — one of 7 categories that determines merge behavior
3. **`content`** — extracted text/data values as a structured object
4. **`style`** — visual properties grouped separately

The `children` array remains, but each child also gets role/content/style separation.

---

## 2. Role Taxonomy

### 2.1 Role Categories (7)

Each category has a **merge rule** that determines which SOM contributes what.

| # | Category | Merge Rule | Description |
|---|---|---|---|
| 1 | **structure** | Style SOM only | Layout skeleton (nav bars, tab bars). Content SOM has no say. |
| 2 | **hero** | Layout from style, content from content | Primary visual area. Style determines size/color/layout. Content provides the data. |
| 3 | **content** | Structure from style, data from content | Information blocks. Style determines card shape, spacing. Content fills in values. |
| 4 | **interactive** | Styling from style, labels from content | Buttons, inputs. Style determines appearance. Content provides label text. |
| 5 | **decorative** | Style SOM only | Visual elements (dividers, icons). Content SOM ignored. |
| 6 | **feedback** | Template from style, message from content | State indicators. Style determines layout. Content provides messages. |
| 7 | **data** | Values from content, typography from style | Pure text/numbers. Style sets font/color. Content sets the actual values. |

### 2.2 Core Roles (~35)

| Role | Category | Description | Name Patterns (for auto-detection) |
|---|---|---|---|
| `screen` | structure | Root frame | screen, root, page, frame-* |
| `nav` | structure | Navigation bar | nav, nav-bar, header, top-bar, navigation |
| `bottom-nav` | structure | Bottom tab bar | bottom-nav, tab-bar, footer-nav |
| `status-bar` | structure | System status | status-bar, system-bar |
| `tab-bar` | structure | Segment control | tab-bar, tabs, segment, switcher |
| `hero` | hero | Primary content area | hero, hero-section, gradient-header, banner-hero |
| `header-image` | hero | Hero photography | header-image, cover, splash |
| `carousel` | hero | Scrollable content | carousel, slider, stories |
| `card` | content | Contained block | card, card-* |
| `section` | content | Grouped area | section, *-section, content-*, details-* |
| `row` | content | Label-value pair | row, row-*, *-row |
| `list` | content | Repeating container | list, *-list, quick-actions, features-* |
| `list-item` | content | Single list item | list-item, action-*, feature-*, nav-* (in bottom-nav) |
| `accordion` | content | Expandable section | accordion, expandable, collapsible |
| `cta` | interactive | Primary action | cta, cta-button, *-btn, send-btn, confirm-* |
| `cta-secondary` | interactive | Secondary action | cta-secondary, outline-btn, price-comparison-* |
| `input` | interactive | Text input | input, search-bar, text-field, amount-* |
| `toggle` | interactive | On/off switch | toggle, switch |
| `checkbox` | interactive | Selection | checkbox, check |
| `swipe-cta` | interactive | Swipe action | swipe-*, slide-* |
| `fab` | interactive | Floating button | fab, floating-* |
| `divider` | decorative | Separator | divider, div, separator, line |
| `pill` | decorative | Small chip/badge | pill, chip, badge, tag, accounts-pill |
| `icon` | decorative | Icon element | icon, icon-* |
| `avatar` | decorative | User identity | avatar, profile-pic, user-image |
| `toast` | feedback | Temp notification | toast, snackbar |
| `modal` | feedback | Overlay dialog | modal, dialog, popup |
| `bottom-sheet` | feedback | Slide-up panel | bottom-sheet, sheet |
| `empty-state` | feedback | Zero-data | empty-state, no-data, transactions-row (if empty) |
| `banner` | feedback | Alert/promo strip | banner, verify-*, alert, notification-card |
| `progress` | feedback | Progress indicator | progress, stepper, step-* |
| `skeleton` | feedback | Loading placeholder | skeleton, shimmer, loading |
| `label` | data | Descriptive text | label, *-label, metric-label |
| `value` | data | Data text | value, *-value, amount-*, balance-* |
| `prompt` | data | Info/safety text | prompt, safety-*, warning-body, *-body |
| `chart` | data | Visualization | chart, graph, data-viz |

### 2.3 Auto-Detection Algorithm

```
function assignRole(node):
  1. Check node.name against Name Patterns (case-insensitive, kebab-case)
  2. If match found → assign role and category
  3. If no match:
     a. Check node.type (ELLIPSE → likely avatar/icon)
     b. Check node.children count (0 children + TEXT type → likely label/value)
     c. Check node position (bottom 80px → likely bottom-nav)
     d. Check node.fills (gradient → likely hero)
  4. If still no match → assign "unknown" role, flag for AI review
```

### 2.4 AI Validation Step

After auto-assignment, Claude reviews the role map:

```
Role Map for revolut_39:
  screen → revolut-home-dark (structure) ✓
  hero → gradient-header (hero) ✓
  nav → top-bar (structure) ✓
  input → search-bar (interactive) ✓
  section → balance-section (content) ✓
  list → quick-actions (content) ✓
  banner → verify-card (feedback) ✓
  empty-state → transactions-row (feedback) ✓
  bottom-nav → bottom-nav (structure) ✓

  UNKNOWN: spacer (1 node) → suggest: decorative/divider

  Conflicts: none
  Confidence: 94%

  Approve? [Yes / Edit / Re-run]
```

---

## 3. Merge Algorithm

### 3.1 Input

```json
{
  "content_som_id": "revolut_39",
  "style_som_id": "fuse_03",
  "mapping": "auto",
  "options": {
    "preserve_content_hierarchy": true,
    "allow_overflow": true,
    "target_width": 390,
    "target_height": 844
  }
}
```

### 3.2 Process

```
function mergeSOM(contentSOM, styleSOM, mapping):

  1. ROLE ASSIGNMENT
     - Auto-assign roles to both SOMs (if not already tagged)
     - Return role maps for AI validation

  2. ROLE MATCHING
     if mapping == "auto":
       - Match nodes by role (hero↔hero, nav↔nav, cta↔cta)
       - Match nodes by roleCategory when exact role doesn't match
       - Flag unmatched nodes
     else:
       - Use custom mapping provided

  3. MERGE BY CATEGORY
     For each matched pair (contentNode, styleNode):

     Category: structure
       → Use styleNode entirely (ignore contentNode)

     Category: hero
       → Use styleNode.style (layout, colors, size)
       → Use contentNode.content (text values, amounts)
       → Preserve styleNode.children structure
       → Replace text content in children by matching child roles

     Category: content
       → Use styleNode.style (card appearance, spacing)
       → Use contentNode.content (data values)
       → OVERFLOW HANDLING:
         - If contentNode has more children than styleNode:
           option A: repeat last styleNode child pattern
           option B: truncate (flag for review)
         - If contentNode has fewer children:
           option A: hide extra styleNode children
           option B: leave with placeholder

     Category: interactive
       → Use styleNode.style (button shape, color, size)
       → Use contentNode.content (label text only)

     Category: decorative
       → Use styleNode entirely

     Category: feedback
       → Use styleNode.style (layout, colors)
       → Use contentNode.content (message text)

     Category: data
       → Use contentNode.content (actual values)
       → Use styleNode.style (font, color, size)

  4. UNMATCHED NODES
     - Content nodes with no style match → append at end, use generic style
     - Style nodes with no content match → keep with placeholder content
     - Flag all unmatched for AI review

  5. OUTPUT
     → Merged SOM (v2 format with roles)
     → Merge report (matches, overflows, unmatched, confidence)
```

### 3.3 Output

```json
{
  "merged_som": { /* v2 SOM */ },
  "report": {
    "matched_roles": 8,
    "unmatched_content": ["change-row"],
    "unmatched_style": ["spacer"],
    "overflows": [
      {
        "role": "list",
        "content_items": 4,
        "style_slots": 2,
        "resolution": "repeat_pattern"
      }
    ],
    "confidence": 0.87,
    "needs_review": true,
    "review_items": [
      "change-row (content) has no match in style SOM — appended at end",
      "list overflow: 4 items vs 2 slots — repeated pattern"
    ]
  }
}
```

---

## 4. Osiris API Endpoints

### 4.1 `osiris_assign_roles`
Assign semantic roles to an existing SOM.

**Input:**
```json
{
  "screen_id": "revolut_39",
  "method": "auto",           // "auto" | "ai_assisted"
  "overrides": {              // optional manual overrides
    "23:2607": "decorative/divider"
  }
}
```

**Output:**
```json
{
  "screen_id": "revolut_39",
  "role_map": [
    { "node_name": "revolut-home-dark", "role": "screen", "category": "structure", "confidence": 1.0 },
    { "node_name": "gradient-header", "role": "hero", "category": "hero", "confidence": 0.95 },
    { "node_name": "top-bar", "role": "nav", "category": "structure", "confidence": 0.98 },
    ...
  ],
  "unknown_nodes": ["spacer"],
  "overall_confidence": 0.94
}
```

### 4.2 `osiris_merge_som`
Merge two SOMs — content from one, style from another.

**Input:**
```json
{
  "content_som_id": "revolut_39",
  "style_som_id": "fuse_03",
  "mapping": "auto",
  "options": {
    "preserve_content_hierarchy": true,
    "allow_overflow": true,
    "target_width": 390,
    "target_height": 844
  }
}
```

**Output:**
```json
{
  "merged_som": { /* complete v2 SOM ready for Rex to build */ },
  "report": {
    "matched_roles": 8,
    "unmatched_content": [],
    "unmatched_style": [],
    "overflows": [],
    "confidence": 0.91,
    "needs_review": false,
    "review_items": []
  }
}
```

### 4.3 `osiris_save_screen_som` (updated)
Existing endpoint — updated to accept v2 SOMs with roles.

The endpoint should:
- Accept both v1 (no roles) and v2 (with roles) SOMs
- If v1 SOM received, auto-assign roles before storing
- Store the role assignments alongside the SOM

---

## 5. Rex Integration

### 5.1 SOM Extraction (Updated)

When Rex extracts a SOM from a Figma frame (via `execute`), it should now also:
1. Read all node properties (including effects, opacity, stroke, clip)
2. Auto-assign roles based on node names
3. Separate content from style in the output
4. Return a v2 SOM

### 5.2 Building from Merged SOM

Rex's `create_node` builds the merged SOM on canvas. Known limitations to address:
- **Negative auto-layout spacing**: `create_node` enforces spacing ≥ 0. Workaround: create with 0, then use `execute` to set negative value.
- **Fill width on children**: Some children need `layoutSizingHorizontal = "FILL"` set after creation via `execute`.
- **Font loading**: `set_text` handles this automatically, but `create_node` with textStyle may fail if font isn't available.

---

## 6. Merge Workflow (End-to-End)

### Step 1: Designer Request
```
"Adapt revolut_39 to the fuse style"
```

### Step 2: Role Assignment
```
Claude → osiris_assign_roles(revolut_39)
Claude → osiris_assign_roles(fuse_03)
Claude reviews both role maps
Claude approves or corrects
```

### Step 3: Merge
```
Claude → osiris_merge_som(revolut_39, fuse_03, auto)
Osiris returns merged SOM + report
Claude reviews report
```

### Step 4: Build
```
Claude → rex create_node (from merged SOM)
Claude → rex execute (fix negative spacing, fill widths)
Claude → rex screenshot (verify result)
```

### Step 5: Validate
```
Claude sends screenshot to chat
Designer reviews
Designer refines manually in Figma
```

### Step 6: Feedback Loop
```
Claude → rex execute (extract refined SOM from Figma)
Claude → osiris_save_screen_som (save as new screen)
Refined SOM becomes new ground truth
```

---

## 7. Edge Cases & Conflict Resolution

### 7.1 More Content Than Style Slots
**Example:** Content SOM has 5 fee rows, style SOM has 2 feature rows.

**Resolution options:**
- `repeat_pattern`: Duplicate the style SOM's list-item pattern for extra items
- `truncate`: Only show first N items (flag for review)
- `paginate`: Split into multiple cards (advanced)

Default: `repeat_pattern`

### 7.2 Less Content Than Style Slots
**Example:** Content SOM has 2 items, style SOM has 4 slots.

**Resolution options:**
- `hide_extra`: Remove unused style slots
- `placeholder`: Keep slots with "—" placeholder
- `collapse`: Reduce container size

Default: `hide_extra`

### 7.3 No Role Match
**Example:** Content SOM has a "change-row" (interactive link), style SOM has nothing similar.

**Resolution:**
- Append unmatched content node at the end of the nearest content section
- Use generic styling from the style SOM's closest category match
- Flag for AI review

### 7.4 Conflicting Hierarchies
**Example:** Content SOM has hero → card → rows, style SOM has hero → list → items.

**Resolution:**
- Match at the deepest common level (hero↔hero)
- Flatten content into style's structure
- AI decides how to redistribute content across style slots

---

## 8. Version Strategy

- **SOM v1**: Current format. No roles, flat properties. Still supported for backward compatibility.
- **SOM v2**: With roles, content/style separation. Used for merge operations.
- **Auto-upgrade**: When v1 SOM enters a merge pipeline, auto-assign roles to produce v2.
- **Storage**: Osiris stores the latest version. `osiris_get_screen_som` returns whatever version is stored.

---

## 9. Implementation Priority

| Phase | What | Owner | Depends On |
|---|---|---|---|
| P0 | Role taxonomy constants + auto-detection function | Osiris | Nothing |
| P0 | v2 SOM schema definition | Osiris | Nothing |
| P1 | `osiris_assign_roles` endpoint | Osiris | P0 |
| P1 | Richer SOM extraction (effects, opacity, stroke) | Rex | Nothing |
| P2 | `osiris_merge_som` endpoint | Osiris | P0, P1 |
| P2 | Negative spacing support in `create_node` | Rex | Nothing |
| P3 | AI validation prompt template | Claude config | P1 |
| P3 | End-to-end merge workflow | Claude orchestration | P1, P2 |
| P4 | Custom mapping UI/UX | TBD | P2 |
| P4 | Merge history / versioning | Osiris | P2 |
