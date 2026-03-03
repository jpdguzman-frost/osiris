# F7 — Score Scatter Plot

## Product Requirements Document

---

## Overview

Interactive 2D scatter plot where each dot is one screen from the dataset. Users pick any two score dimensions for X and Y axes, colored by industry. Reveals clusters, outliers, and cross-industry positioning at a glance — e.g., "Where does fintech sit on calm↔energetic vs premium↔accessible?"

---

## Current State

### Data available (DO NOT rewrite, just query)

Every screen in the `screens` collection has `analysis.scores` with **14 dimensions**:

**Core Metrics (1–10 scale):**
| Field | Description |
|---|---|
| `overall_quality` | Holistic design quality |
| `calm_confident` | Calm & Confident territory score |
| `bold_forward` | Bold & Forward territory score |
| `color_restraint` | Palette discipline |
| `hierarchy_clarity` | Visual hierarchy strength |
| `glanceability` | Information scanability |
| `density` | Content packing |
| `whitespace_ratio` | Breathing room |
| `brand_confidence` | Brand expression strength |

**Emotional Spectrum (–5 to +5 scale):**
| Field | Left (negative) | Right (positive) |
|---|---|---|
| `calm_energetic` | Calm | Energetic |
| `confident_tentative` | Confident | Tentative |
| `forward_conservative` | Forward | Conservative |
| `premium_accessible` | Premium | Accessible |
| `warm_clinical` | Warm | Clinical |

**Total screens:** 3,486 across 7 industries.

### Existing infrastructure
- Express server at `server.js` with existing API endpoints
- Ractive SPA at `frontend/` (index.html, js/app.js, css/app.css)
- `GET /api/screens` returns paginated screens with scores
- `GET /api/industries` returns industry list with counts
- `GET /api/vocabularies` returns all enums

---

## Requirements

### API: New Endpoint

**`GET /api/scatter`**

Returns all screens with just the fields needed for plotting — minimal payload.

| Param | Source | Type | Default | Description |
|---|---|---|---|---|
| `x` | query | string | `"calm_energetic"` | Score field for X axis |
| `y` | query | string | `"premium_accessible"` | Score field for Y axis |
| `industry` | query | string | `""` | Optional: filter to one industry |
| `screen_type` | query | string | `""` | Optional: filter by screen type |
| `mood` | query | string | `""` | Optional: filter by design mood |

**Response shape:**
```json
{
  "x_field": "calm_energetic",
  "y_field": "premium_accessible",
  "x_range": [-5, 5],
  "y_range": [-5, 5],
  "count": 3486,
  "points": [
    {
      "id": "coinbase_02",
      "industry": "fintech",
      "x": -2,
      "y": -4,
      "quality": 8,
      "screen_type": "onboarding",
      "verdict": "Masterclass in restraint..."
    }
  ]
}
```

**Implementation:**
```js
// Valid score fields the user can pick
const SCORE_FIELDS = {
  // Core (1-10)
  overall_quality: [1, 10],
  calm_confident: [1, 10],
  bold_forward: [1, 10],
  color_restraint: [1, 10],
  hierarchy_clarity: [1, 10],
  glanceability: [1, 10],
  density: [1, 10],
  whitespace_ratio: [1, 10],
  brand_confidence: [1, 10],
  // Spectrum (-5 to +5)
  calm_energetic: [-5, 5],
  confident_tentative: [-5, 5],
  forward_conservative: [-5, 5],
  premium_accessible: [-5, 5],
  warm_clinical: [-5, 5],
};

app.get('/api/scatter', async (req, res) => {
  try {
    const xField = req.query.x || 'calm_energetic';
    const yField = req.query.y || 'premium_accessible';

    if (!SCORE_FIELDS[xField] || !SCORE_FIELDS[yField]) {
      return res.status(400).json({ error: 'Invalid score field' });
    }

    const filter = {};
    if (req.query.industry) filter.industry = req.query.industry;
    if (req.query.screen_type) filter['analysis.screen_type'] = req.query.screen_type;
    if (req.query.mood) filter['fingerprint.design_mood'] = req.query.mood;

    const screens = await store.db.collection('screens')
      .find(filter)
      .project({
        screen_id: 1,
        industry: 1,
        file_path: 1,
        [`analysis.scores.${xField}`]: 1,
        [`analysis.scores.${yField}`]: 1,
        'analysis.scores.overall_quality': 1,
        'analysis.screen_type': 1,
        'analysis.verdict': 1,
      })
      .toArray();

    const points = screens.map(s => ({
      id: s.screen_id,
      industry: s.industry,
      x: s.analysis?.scores?.[xField] ?? 0,
      y: s.analysis?.scores?.[yField] ?? 0,
      quality: s.analysis?.scores?.overall_quality ?? 0,
      screen_type: s.analysis?.screen_type || '',
      verdict: s.analysis?.verdict || '',
    }));

    res.json({
      x_field: xField,
      y_field: yField,
      x_range: SCORE_FIELDS[xField],
      y_range: SCORE_FIELDS[yField],
      count: points.length,
      points,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

**Performance note:** 3,486 points × ~120 bytes each ≈ 420KB JSON. This is fine for a single fetch. No pagination needed.

---

### Frontend: New "Scatter" View

Add a third top-level view accessible from the nav bar: **Dashboard | Gallery | Scatter**

#### Route

`#/scatter` → renders the scatter partial.

Update `frontend/js/app.js` routing:
```js
// In getRoute():
if (hash === '/scatter' || hash.startsWith('/scatter')) return { view: 'scatter' };

// In handleRoute():
if (route.view === 'scatter' && prevView !== 'scatter') {
  app.loadScatter();
}
```

Update nav in `#app-template`:
```html
<div class="nav-link {{#if currentView === 'scatter'}}active{{/if}}" on-click="@this.navigate('/scatter')">Scatter</div>
```

#### Charting Library

Use **Chart.js** loaded from CDN. It's a single `<script>` tag — no build step, no npm dependency.

```html
<!-- Add to <head> in index.html -->
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
```

Chart.js has a native scatter chart type with tooltip, zoom, and click support.

#### Layout

```
┌──────────────────────────────────────────────────────┐
│  Score Scatter                                        │
│  Explore score relationships across 3,486 screens     │
│                                                       │
│  [X Axis ▾]  [Y Axis ▾]  [Industry ▾]  [Mood ▾]     │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │                                                 │  │
│  │              ·  · ·                             │  │
│  │         · ·    ·  ·  ·                          │  │
│  │       ·  · ··  ·     · ·                        │  │
│  │    Y  ·  ···· ··  ·    ·                        │  │
│  │       · · ·· · ·  · ·  ·                        │  │
│  │        ·  · ·  ·   ·                            │  │
│  │          ·   ·                                  │  │
│  │                              X ───────>         │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
│  ● fintech (1596)  ● luxury (270)  ● aerospace (295) │
│  ● automotive (230) ● gaming (355) ● health (473)    │
│  ● gcash_current (267)                                │
└──────────────────────────────────────────────────────┘
```

#### Axis Selectors

Two `<select>` dropdowns, one for X and one for Y. Each lists all 14 score fields grouped into two `<optgroup>`s:

```html
<select>
  <optgroup label="Core Metrics (1–10)">
    <option value="overall_quality">Overall Quality</option>
    <option value="calm_confident">Calm & Confident</option>
    <option value="bold_forward">Bold & Forward</option>
    <option value="color_restraint">Color Restraint</option>
    <option value="hierarchy_clarity">Hierarchy Clarity</option>
    <option value="glanceability">Glanceability</option>
    <option value="density">Density</option>
    <option value="whitespace_ratio">Whitespace Ratio</option>
    <option value="brand_confidence">Brand Confidence</option>
  </optgroup>
  <optgroup label="Emotional Spectrum (–5 to +5)">
    <option value="calm_energetic">Calm ↔ Energetic</option>
    <option value="confident_tentative">Confident ↔ Tentative</option>
    <option value="forward_conservative">Forward ↔ Conservative</option>
    <option value="premium_accessible">Premium ↔ Accessible</option>
    <option value="warm_clinical">Warm ↔ Clinical</option>
  </optgroup>
</select>
```

Default selection: **X = `calm_energetic`**, **Y = `premium_accessible`** (the most useful strategic view).

#### Industry Colors

Assign a fixed color per industry. Use these consistently:

```js
const INDUSTRY_COLORS = {
  fintech:       '#2D5BFF', // blue (primary brand)
  luxury:        '#000000', // black
  aerospace:     '#6366F1', // indigo
  automotive:    '#059669', // emerald
  gaming:        '#DC2626', // red
  health:        '#0891B2', // cyan
  gcash_current: '#F59E0B', // amber
};
```

Each industry is a separate Chart.js dataset so the legend toggles visibility per industry.

#### Dot Rendering

- **Size:** 6px radius default. Optional: scale by `overall_quality` (quality 10 → 8px, quality 1 → 4px)
- **Opacity:** 0.65 (so overlapping dots blend rather than occlude)
- **Hover:** Increase radius to 10px, full opacity, show tooltip

#### Tooltip (on hover)

```
┌──────────────────────────┐
│  coinbase_02             │
│  fintech · onboarding    │
│  Quality: 8/10           │
│  X: -2  Y: -4            │
│  "Masterclass in rest…"  │
└──────────────────────────┘
```

Use Chart.js custom tooltip callback to format this.

#### Click Behavior

Clicking a dot navigates to that screen's detail page: `window.location.hash = '#/screen/' + point.id`

#### Quick Presets (optional nice-to-have)

A row of preset buttons above the chart for common strategic views:

| Label | X | Y |
|---|---|---|
| Strategic Territory | `calm_energetic` | `premium_accessible` |
| Design Quality | `overall_quality` | `brand_confidence` |
| Calm vs Bold | `calm_confident` | `bold_forward` |
| Space & Clarity | `whitespace_ratio` | `hierarchy_clarity` |

These just set the X/Y dropdowns and re-fetch.

#### Axis Labels

For spectrum fields, show both poles on the axis:

```
X axis: "← Calm · · · Energetic →"
Y axis: "← Premium · · · Accessible →"  (rotated 90°)
```

For core metrics, just show the field name:
```
X axis: "Overall Quality (1–10)"
```

Build these labels dynamically from a lookup:
```js
const AXIS_LABELS = {
  overall_quality: 'Overall Quality (1–10)',
  calm_confident: 'Calm & Confident (1–10)',
  // ...
  calm_energetic: '← Calm · · · · · Energetic →',
  confident_tentative: '← Confident · · · · · Tentative →',
  forward_conservative: '← Forward · · · · · Conservative →',
  premium_accessible: '← Premium · · · · · Accessible →',
  warm_clinical: '← Warm · · · · · Clinical →',
};
```

---

### Data Flow

```
User selects X = "calm_energetic", Y = "premium_accessible", Industry = "all"
  ↓
Frontend: GET /api/scatter?x=calm_energetic&y=premium_accessible
  ↓
Server: Queries all 3,486 screens, projects only needed fields
  ↓
Response: 3,486 points with id, industry, x, y, quality, screen_type, verdict
  ↓
Frontend: Groups points by industry → 7 Chart.js datasets
  ↓
Chart.js renders scatter plot with colored dots, legend, tooltips
  ↓
User changes axis → re-fetch → chart.update()
User clicks dot → navigate to #/screen/:id
User toggles industry in legend → Chart.js hides/shows that dataset
```

---

### File Manifest

| File | Action | What Changes |
|---|---|---|
| `server.js` | MODIFY | Add `GET /api/scatter` endpoint |
| `frontend/index.html` | MODIFY | Add Chart.js CDN `<script>`, add `#scatter-template` partial, add nav link |
| `frontend/js/app.js` | MODIFY | Add scatter view state, `loadScatter()` method, Chart.js init/update, route handling |
| `frontend/css/app.css` | MODIFY | Add scatter layout styles (filters row, chart container, presets) |

---

### Design Specifications

**Chart container:**
```css
.scatter-container {
  position: relative;
  width: 100%;
  /* 16:10 aspect ratio for the chart */
  aspect-ratio: 16 / 10;
  max-height: 640px;
  background: var(--color-bg);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
}
```

**Filter bar:** Reuse existing `.gallery-filters` pattern with `.filter-group`, `.filter-label`, `.filter-select`.

**Preset buttons:** Reuse `.preset-pill` / `.preset-pill.active` pattern from the similarity feature.

**Legend:** Use Chart.js built-in legend. Override font to `var(--font)` via Chart.js `defaults.font.family`.

**Page layout:** Use `.page.page--contained` with the same header pattern as dashboard/gallery.

---

### Acceptance Criteria

1. **Scatter page accessible from nav** — third nav link "Scatter", routes to `#/scatter`
2. **X and Y axis selectors work** — all 14 score fields available, changing either re-fetches and redraws
3. **Dots colored by industry** — using fixed industry color palette, legend toggles visibility
4. **Tooltip on hover** — shows screen_id, industry, screen_type, quality, X/Y values, truncated verdict
5. **Click navigates to detail** — clicking a dot goes to `#/screen/:id`
6. **Industry filter works** — dropdown filters to single industry
7. **Chart renders 3,486 points smoothly** — no visible lag on load or axis change
8. **Axis labels correct** — spectrum fields show both poles, core metrics show name + range
9. **No new npm dependencies** — Chart.js loaded from CDN only
10. **No regressions** — dashboard, gallery, detail, similarity all work unchanged
