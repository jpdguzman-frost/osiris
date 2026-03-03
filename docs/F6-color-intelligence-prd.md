# F6 — Color Intelligence Report

## Product Requirements Document

---

## Overview

A dedicated "Color" view in the gallery that aggregates color palette data across all 3,486 screens. Reveals dominant color strategies per industry, color temperature distributions, dark mode adoption, most-used hex colors, and accent color patterns. All data-driven — zero Claude API calls, pure MongoDB aggregations.

---

## Current State

### Data available per screen

Every screen in the `screens` collection has:

```json
{
  "analysis": {
    "color_palette": {
      "dominant": ["#000000", "#FFFFFF", "#1A1A1A"],  // 2-3 hex colors (97% have exactly 3)
      "accent": "#4CAF50",                             // single hex
      "strategy": "monochromatic",                     // enum: 7 values
      "dark_mode": true                                // boolean
    }
  },
  "fingerprint": {
    "color_temp": "cool",                              // enum: warm, cool, neutral, mixed
    "has_gradient": false                               // boolean
  }
}
```

**Current data stats (3,486 screens):**

| Industry | Screens | Dark Mode | Top Strategies |
|---|---|---|---|
| fintech | 1,596 | 134 (8%) | neutral_plus_accent, complementary |
| aerospace | 295 | 247 (84%) | monochromatic, analogous |
| luxury | 270 | 15 (6%) | monochromatic, analogous |
| automotive | 230 | 110 (48%) | neutral_plus_accent, analogous |
| health | 473 | 187 (40%) | neutral_plus_accent, complementary |
| gaming | 355 | 258 (73%) | analogous, complementary |
| gcash_current | 267 | 3 (1%) | neutral_plus_accent, analogous |

**Enum values:**
- `strategy`: monochromatic, analogous, complementary, triadic, neutral_plus_accent, duotone, gradient_heavy
- `color_temp`: warm, cool, neutral, mixed

---

## Requirements

### API: New Endpoint

**`GET /api/color-intelligence`**

Returns pre-computed aggregations. No pagination — single payload.

| Param | Source | Type | Default | Description |
|---|---|---|---|---|
| `industry` | query | string | `""` | Optional: filter to one industry |

**Response shape:**
```json
{
  "total": 3486,
  "filter": null,

  "strategyByIndustry": [
    { "industry": "fintech", "strategy": "neutral_plus_accent", "count": 620, "pct": 38.8 },
    { "industry": "fintech", "strategy": "monochromatic", "count": 410, "pct": 25.7 },
    ...
  ],

  "tempByIndustry": [
    { "industry": "fintech", "temp": "cool", "count": 800, "pct": 50.1 },
    ...
  ],

  "darkModeByIndustry": [
    { "industry": "fintech", "total": 1596, "dark": 134, "pct": 8.4 },
    { "industry": "aerospace", "total": 295, "dark": 247, "pct": 83.7 },
    ...
  ],

  "gradientByIndustry": [
    { "industry": "gaming", "total": 355, "gradient": 120, "pct": 33.8 },
    ...
  ],

  "topDominantColors": [
    { "hex": "#FFFFFF", "count": 2890, "pct": 82.9 },
    { "hex": "#000000", "count": 2105, "pct": 60.4 },
    { "hex": "#1A1A1A", "count": 654, "pct": 18.8 },
    ...
  ],

  "topAccentColors": [
    { "hex": "#2D5BFF", "count": 145, "pct": 4.2 },
    { "hex": "#4CAF50", "count": 98, "pct": 2.8 },
    ...
  ],

  "strategyTotals": [
    { "strategy": "neutral_plus_accent", "count": 1240, "pct": 35.6 },
    { "strategy": "monochromatic", "count": 820, "pct": 23.5 },
    ...
  ],

  "tempTotals": [
    { "temp": "cool", "count": 1400, "pct": 40.2 },
    ...
  ]
}
```

**Implementation:**

```js
app.get('/api/color-intelligence', async (req, res) => {
  try {
    const screens = store.db.collection('screens');
    const filter = {};
    if (req.query.industry) filter.industry = req.query.industry;

    const total = await screens.countDocuments(filter);

    // 1. Strategy breakdown by industry
    const strategyByIndustry = await screens.aggregate([
      { $match: filter },
      { $group: {
        _id: { industry: '$industry', strategy: '$analysis.color_palette.strategy' },
        count: { $sum: 1 },
      }},
      { $sort: { count: -1 } },
    ]).toArray();

    // 2. Color temp by industry
    const tempByIndustry = await screens.aggregate([
      { $match: filter },
      { $group: {
        _id: { industry: '$industry', temp: '$fingerprint.color_temp' },
        count: { $sum: 1 },
      }},
      { $sort: { count: -1 } },
    ]).toArray();

    // 3. Dark mode by industry
    const darkModeByIndustry = await screens.aggregate([
      { $match: filter },
      { $group: {
        _id: '$industry',
        total: { $sum: 1 },
        dark: { $sum: { $cond: ['$analysis.color_palette.dark_mode', 1, 0] } },
      }},
    ]).toArray();

    // 4. Gradient usage by industry
    const gradientByIndustry = await screens.aggregate([
      { $match: filter },
      { $group: {
        _id: '$industry',
        total: { $sum: 1 },
        gradient: { $sum: { $cond: ['$fingerprint.has_gradient', 1, 0] } },
      }},
    ]).toArray();

    // 5. Top dominant colors (unwind the array, group by hex)
    const topDominantColors = await screens.aggregate([
      { $match: filter },
      { $unwind: '$analysis.color_palette.dominant' },
      { $group: { _id: '$analysis.color_palette.dominant', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 30 },
    ]).toArray();

    // 6. Top accent colors
    const topAccentColors = await screens.aggregate([
      { $match: filter },
      { $match: { 'analysis.color_palette.accent': { $ne: null } } },
      { $group: { _id: '$analysis.color_palette.accent', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 30 },
    ]).toArray();

    // 7. Strategy totals (across all industries)
    const strategyTotals = await screens.aggregate([
      { $match: filter },
      { $group: { _id: '$analysis.color_palette.strategy', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray();

    // 8. Temp totals
    const tempTotals = await screens.aggregate([
      { $match: filter },
      { $group: { _id: '$fingerprint.color_temp', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray();

    // Format helper
    const pct = (n, t) => Math.round((n / t) * 1000) / 10;

    res.json({
      total,
      filter: req.query.industry || null,

      strategyByIndustry: strategyByIndustry.map(r => ({
        industry: r._id.industry, strategy: r._id.strategy, count: r.count, pct: pct(r.count, total),
      })),

      tempByIndustry: tempByIndustry.map(r => ({
        industry: r._id.industry, temp: r._id.temp, count: r.count, pct: pct(r.count, total),
      })),

      darkModeByIndustry: darkModeByIndustry.map(r => ({
        industry: r._id, total: r.total, dark: r.dark, pct: pct(r.dark, r.total),
      })),

      gradientByIndustry: gradientByIndustry.map(r => ({
        industry: r._id, total: r.total, gradient: r.gradient, pct: pct(r.gradient, r.total),
      })),

      topDominantColors: topDominantColors.map(r => ({
        hex: r._id, count: r.count, pct: pct(r.count, total),
      })),

      topAccentColors: topAccentColors.map(r => ({
        hex: r._id, count: r.count, pct: pct(r.count, total),
      })),

      strategyTotals: strategyTotals.map(r => ({
        strategy: r._id, count: r.count, pct: pct(r.count, total),
      })),

      tempTotals: tempTotals.map(r => ({
        temp: r._id, count: r.count, pct: pct(r.count, total),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

**Performance note:** 8 aggregation pipelines on 3,486 docs completes in ~50ms. No caching needed.

---

### Frontend: New "Color" View

Add a fourth top-level view: **Dashboard | Gallery | Scatter | Color**

Route: `#/color`

#### Page Layout

```
┌────────────────────────────────────────────────────────────┐
│  Color Intelligence                                         │
│  Color strategy patterns across 3,486 screens               │
│                                                             │
│  [Industry ▾ All Industries]                                │
│                                                             │
│  ┌─── Color Strategy Distribution ──────────────────────┐  │
│  │                                                       │  │
│  │  [stacked horizontal bar chart — one bar per industry │  │
│  │   segments colored by strategy]                       │  │
│  │                                                       │  │
│  │  ● monochromatic  ● analogous  ● complementary       │  │
│  │  ● triadic  ● neutral_plus_accent  ● duotone         │  │
│  │  ● gradient_heavy                                     │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─── Dark Mode ────┐  ┌─── Color Temperature ──────────┐  │
│  │                   │  │                                │  │
│  │  aerospace  ████░ │  │  [stacked bars by industry,    │  │
│  │  gaming     ███░░ │  │   segments = warm/cool/etc]    │  │
│  │  automotive ██░░░ │  │                                │  │
│  │  health     ██░░░ │  │                                │  │
│  │  fintech    █░░░░ │  │                                │  │
│  │  luxury     ░░░░░ │  │                                │  │
│  │  gcash      ░░░░░ │  │                                │  │
│  │                   │  │                                │  │
│  └───────────────────┘  └────────────────────────────────┘  │
│                                                             │
│  ┌─── Most Used Dominant Colors ────────────────────────┐  │
│  │                                                       │  │
│  │  ██ #FFFFFF   82.9% (2,890)                          │  │
│  │  ██ #000000   60.4% (2,105)                          │  │
│  │  ██ #1A1A1A   18.8% (654)                            │  │
│  │  ██ #F5F5F5   12.1% (422)                            │  │
│  │  ...top 20                                            │  │
│  │                                                       │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─── Most Used Accent Colors ──────────────────────────┐  │
│  │                                                       │  │
│  │  ██ #2D5BFF   4.2% (145)     ██ #4CAF50  2.8% (98)  │  │
│  │  ██ #FF6B00   2.3% (80)      ██ #7C3AED  1.9% (66)  │  │
│  │  ...top 20 as swatch grid                             │  │
│  │                                                       │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─── Gradient Usage ───────────────────────────────────┐  │
│  │  [same horizontal bar pattern as dark mode]           │  │
│  └───────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

---

### Section Details

#### 1. Color Strategy Distribution (Stacked Horizontal Bars)

One bar per industry. Each bar subdivided by strategy, showing proportional breakdown.

Use Chart.js horizontal stacked bar chart. Each strategy is a dataset with its assigned color:

```js
const STRATEGY_COLORS = {
  monochromatic:       '#1A1A1A',
  analogous:           '#6366F1',
  complementary:       '#2D5BFF',
  triadic:             '#059669',
  neutral_plus_accent: '#93939E',
  duotone:             '#D97706',
  gradient_heavy:      '#DC2626',
};
```

Bar labels = industry names. Y-axis = industry. X-axis = count (or percentage with toggle).

#### 2. Dark Mode Adoption (Horizontal Progress Bars)

Simple horizontal bars sorted by dark mode percentage (highest first). No Chart.js needed — pure HTML/CSS.

```html
<div class="color-stat-row">
  <div class="color-stat-label">aerospace</div>
  <div class="color-stat-bar-track">
    <div class="color-stat-bar-fill" style="width: 83.7%"></div>
  </div>
  <div class="color-stat-value">84%</div>
  <div class="color-stat-count">247 / 295</div>
</div>
```

Reuse the `.industry-bar-track` / `.industry-bar-fill` pattern from the dashboard but with a darker fill color for dark mode bars.

#### 3. Color Temperature (Stacked Horizontal Bars)

Same pattern as strategy distribution but with 4 segments:

```js
const TEMP_COLORS = {
  warm:    '#F59E0B',
  cool:    '#3B82F6',
  neutral: '#93939E',
  mixed:   '#8B5CF6',
};
```

#### 4. Most Used Dominant Colors (Color Swatch List)

Top 20 dominant hex colors. Each row:
- Color swatch (32×32px square with that hex)
- Hex label
- Percentage bar
- Count

Click a color → navigates to gallery filtered by that dominant color (optional nice-to-have, requires adding a dominant color filter to the gallery API — skip if complex).

#### 5. Most Used Accent Colors (Swatch Grid)

Top 20 accent colors in a wrapped grid of larger swatches (48×48px). Below each swatch: hex code and count. Renders as a flex-wrap grid.

#### 6. Gradient Usage (Horizontal Progress Bars)

Same layout as dark mode — one bar per industry showing gradient adoption %.

---

### Interaction: Industry Filter

A single industry dropdown at the top of the page. Selecting an industry:
- Re-fetches `GET /api/color-intelligence?industry=fintech`
- All sections update to show data for that industry only
- Strategy bars, temp bars, and dark mode bars show just that industry's data
- Color swatch lists filter to that industry's palette

When "All Industries" is selected, the default cross-industry view is shown.

---

### Hex Color Grouping (Important)

Raw hex colors have slight variations (`#FFFFFF` vs `#FAFAFA` vs `#F5F5F5`). The top dominant colors list will naturally show the most common exact hex values. This is fine — don't try to cluster/group similar colors. The data is already clean because Claude outputs a limited palette (2–3 dominant colors per screen).

However, for accent colors there may be more variation. Show the top 20 as-is. If the list looks noisy with very similar colors, a future enhancement could bucket by HSL proximity — but **do not implement that now**.

---

### Data Flow

```
User navigates to #/color
  ↓
Frontend: GET /api/color-intelligence
  ↓
Server: Runs 8 MongoDB aggregation pipelines
  ↓
Response: Strategy, temp, dark mode, gradient, dominant colors, accent colors
  ↓
Frontend: Renders Chart.js stacked bars + HTML stat bars + swatch grids
  ↓
User selects industry filter → re-fetch → all sections update
```

---

### File Manifest

| File | Action | What Changes |
|---|---|---|
| `server.js` | MODIFY | Add `GET /api/color-intelligence` endpoint |
| `frontend/index.html` | MODIFY | Add `#color-template` partial, add Chart.js CDN (if not already added by F7), add nav link |
| `frontend/js/app.js` | MODIFY | Add color view state, `loadColorIntelligence()` method, Chart.js bar chart init, route handling |
| `frontend/css/app.css` | MODIFY | Add color intelligence layout styles (stat rows, swatch grids, section cards) |

---

### Design Specifications

**Section cards:**
```css
.color-section {
  background: var(--color-bg-raised);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  padding: var(--space-6);
  margin-bottom: var(--space-6);
}

.color-section-title {
  font-size: var(--text-md);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  margin-bottom: var(--space-5);
}
```

**Stat bars (dark mode, gradient):**
```css
.color-stat-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) 0;
}

.color-stat-label {
  flex: 0 0 120px;
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
}

.color-stat-bar-track {
  flex: 1;
  height: 8px;
  background: var(--color-bg-inset);
  border-radius: var(--radius-full);
  overflow: hidden;
}

.color-stat-bar-fill {
  height: 100%;
  border-radius: var(--radius-full);
  transition: width var(--transition-slow);
}

.color-stat-value {
  flex: 0 0 40px;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  text-align: right;
}

.color-stat-count {
  flex: 0 0 80px;
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  text-align: right;
}
```

**Color swatches (dominant list):**
```css
.color-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) 0;
}

.color-swatch-lg {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  flex-shrink: 0;
}

.color-hex {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--color-text);
  flex: 0 0 80px;
}
```

**Accent swatch grid:**
```css
.accent-grid {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.accent-swatch {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  width: 64px;
}

.accent-swatch-color {
  width: 48px;
  height: 48px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-border);
}

.accent-swatch-label {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}
```

**Two-column sections:** Dark mode + color temp can sit side by side:
```css
.color-split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-6);
}

@media (max-width: 768px) {
  .color-split {
    grid-template-columns: 1fr;
  }
}
```

**Chart container for stacked bars:**
```css
.color-chart-container {
  position: relative;
  width: 100%;
  height: 300px;
}
```

---

### Acceptance Criteria

1. **Color page accessible from nav** — fourth link "Color", routes to `#/color`
2. **Strategy distribution renders** — stacked horizontal bar chart with all 7 strategies × 7 industries
3. **Dark mode bars render** — sorted by percentage, bars visually proportional
4. **Color temperature renders** — stacked bars with warm/cool/neutral/mixed
5. **Top 20 dominant colors render** — swatches with hex, percentage, count
6. **Top 20 accent colors render** — swatch grid with hex labels
7. **Gradient usage bars render** — same format as dark mode
8. **Industry filter works** — selecting an industry re-fetches and updates all sections
9. **No new npm dependencies** — Chart.js from CDN only (shared with F7)
10. **Response time < 200ms** — for the /api/color-intelligence endpoint
11. **No regressions** — all existing views work unchanged

---

### Chart.js Shared Note

If F7 (Score Scatter) is built first, Chart.js CDN will already be in `index.html`. If F6 is built first, add it:

```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
```

Only one `<script>` tag needed — both features share the same Chart.js instance.
