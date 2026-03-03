# F1 — Similarity Search in Gallery UI

## Product Requirements Document

---

## Overview

Surface the existing 3-layer similarity search engine (currently CLI-only) in the Osiris web gallery. Users should be able to click "Find Similar" on any screen detail page and see a ranked grid of visually/conceptually similar screens from the entire dataset.

---

## Current State

### What already works (DO NOT rewrite these)

1. **Similarity engine** — `src/similarity.js` (257 lines, fully tested)
   - 3-layer fusion: semantic (fingerprint tags/enums/booleans) + visual (84-dim Sharp pixel vectors) + score (14-dim normalized scores)
   - `findSimilar(target, allScreens, { weights, top })` → returns ranked results with per-layer breakdown
   - `textSearch(query, allScreens, { top })` → synonym-aware tag/enum/verdict matching
   - 4 weight presets: `default`, `visual`, `conceptual`, `quality`

2. **Data layer** — `src/store.js`
   - `getScreensWithFingerprints(filter)` → returns all screens with `fingerprint`, `visual_features`, `analysis.scores`, `analysis.verdict`
   - `getScreen(screenId)` → full single screen document

3. **Gallery web app** — Express server (`server.js`) + Ractive SPA (`frontend/`)
   - Routes: `#/` (dashboard), `#/gallery` (filtered grid), `#/screen/:id` (detail)
   - API: `GET /api/screens`, `GET /api/screens/:id`, `GET /api/stats`, `GET /api/vocabularies`, `GET /api/industries`

4. **CLI reference** — `scripts/search.js` shows how the engine is called today

---

## Requirements

### API: New Endpoint

**`GET /api/similar/:screenId`**

| Param | Source | Type | Default | Description |
|---|---|---|---|---|
| `screenId` | URL path | string | required | The anchor screen to find similarities for |
| `preset` | query | string | `"default"` | Weight preset: `default`, `visual`, `conceptual`, `quality` |
| `top` | query | int | `12` | Number of results (max 50) |
| `industry` | query | string | `""` | Optional: limit results to a specific industry |

**Response shape:**
```json
{
  "anchor": "fintech_042",
  "preset": "default",
  "weights": { "semantic": 0.35, "visual": 0.40, "score": 0.25 },
  "results": [
    {
      "screen_id": "luxury_118",
      "industry": "luxury",
      "file_path": "luxury/luxury_118.png",
      "image_url": "/screens/luxury/luxury_118.png",
      "similarity": {
        "total": 0.847,
        "semantic": 0.792,
        "visual": 0.901,
        "score": 0.813
      },
      "analysis": {
        "scores": { "overall_quality": 8, ... },
        "verdict": "...",
        "screen_type": "dashboard",
        "platform": "ios"
      },
      "fingerprint": {
        "style_tags": ["minimal", "clean"],
        "design_mood": "calm",
        ...
      }
    }
  ]
}
```

### Implementation Notes for the API

```js
// In server.js — add this endpoint

import { findSimilar, WEIGHT_PRESETS } from './src/similarity.js';

app.get('/api/similar/:screenId', async (req, res) => {
  // 1. Get anchor screen
  const anchor = await store.getScreen(req.params.screenId);
  if (!anchor) return res.status(404).json({ error: 'Screen not found' });

  // 2. Load all screens with fingerprints (this is the candidate pool)
  const filter = {};
  if (req.query.industry) filter.industry = req.query.industry;
  const allScreens = await store.getScreensWithFingerprints(filter);

  // 3. Run similarity search
  const presetName = req.query.preset || 'default';
  const weights = WEIGHT_PRESETS[presetName] || WEIGHT_PRESETS.default;
  const top = Math.min(parseInt(req.query.top) || 12, 50);

  const results = findSimilar(anchor, allScreens, { weights, top });

  // 4. Enrich results with image_url
  const enriched = results.map(r => {
    const screen = allScreens.find(s => s.screen_id === r.screen_id);
    return {
      screen_id: r.screen_id,
      industry: r.industry,
      file_path: screen?.file_path,
      image_url: `/screens/${r.industry}/${screen?.file_path}`,
      similarity: r.similarity,
      analysis: screen?.analysis,
      fingerprint: screen?.fingerprint,
    };
  });

  res.json({
    anchor: req.params.screenId,
    preset: presetName,
    weights,
    results: enriched,
  });
});
```

**Performance note:** `getScreensWithFingerprints()` loads ~1,040 screens into memory (currently ~3MB). This is fine for the current dataset size. The brute-force `findSimilar` runs in <100ms on 1K screens. If the dataset grows past 5K, consider caching `allScreens` in memory on the server (refresh on a timer or POST /api/cache/refresh).

---

### Frontend: UI Changes

All frontend code lives in three files. Do not introduce new frameworks or build steps.

| File | Role |
|---|---|
| `frontend/index.html` | Ractive templates (partials: dashboard, gallery, detail) |
| `frontend/js/app.js` | Ractive app logic + API client + routing |
| `frontend/css/app.css` | All styles (design tokens at top) |

#### 1. Detail Page — "Find Similar" Button

On the `#detail-template` partial, add a **"Find Similar" button** below the fingerprint section (or in the detail hero area). When clicked:
- Shows a preset selector (4 pills/tabs: Default, Visual, Conceptual, Quality)
- Fires `GET /api/similar/:screenId?preset=X&top=12`
- Renders results in a horizontal scrolling row or a grid below the detail content

#### 2. Similar Results Section

Display similar screens as a grid of cards (reuse the existing `.screen-card` component). Each card should additionally show:
- **Similarity score badge** — the `total` score as a percentage (e.g., "85%") replacing the quality score position
- **Per-layer breakdown on hover** — tooltip or small text showing semantic/visual/score breakdown

The section should include:
- A section header: "Similar Screens" with the active preset indicated
- The 4 preset pills as toggleable filters (clicking a different preset re-fetches)
- Optional: an industry filter dropdown to scope results to one industry

#### 3. Gallery Card — Quick "Find Similar" Action

On gallery screen cards (`.screen-card`), add a small icon button (e.g., a "⊞" or "similar" icon) that appears on hover. Clicking it navigates to `#/screen/:id` and auto-triggers the similarity search. This is a nice-to-have, not required.

#### 4. API Client Addition

In `app.js`, add to the `api` object:
```js
similar: (id, params) => api.get('/api/similar/' + encodeURIComponent(id) + '?' + new URLSearchParams(params)),
```

---

### Design Specifications

Follow the existing design system. Key tokens from `app.css`:

**Preset pills (active/inactive states):**
```css
/* Reuse .pill pattern but with interactive states */
.preset-pill {
  /* Base: same as .pill-neutral */
  background: var(--color-bg-inset);       /* #ECECEE */
  color: var(--color-text-secondary);       /* #5F5F6A */
  cursor: pointer;
  transition: all var(--transition);        /* 180ms ease */
}
.preset-pill:hover {
  background: var(--color-bg-hover);        /* #F0F0F2 */
}
.preset-pill.active {
  background: var(--color-accent-light);    /* #EEF2FF */
  color: var(--color-accent);               /* #2D5BFF */
}
```

**Similarity score badge:**
```css
/* On the similar result cards, show similarity % instead of quality score */
/* Use the existing .pill-score pattern */
/* 85%+ → .high (green), 70-84% → .mid (yellow), <70% → .low (red) */
```

**Section styling:**
- Use existing `.section` + `.section-title` pattern
- Similar results grid: same `.screen-grid` with `grid-template-columns: repeat(auto-fill, minmax(160px, 1fr))`

**Loading state:**
- While fetching similar results, show the existing `.loading` spinner (3 dots)
- Keep the rest of the detail page visible and interactive during the load

---

### Data Flow

```
User clicks "Find Similar" on detail page
  ↓
Frontend: GET /api/similar/fintech_042?preset=default&top=12
  ↓
Server:
  1. store.getScreen("fintech_042")         → anchor screen (full doc)
  2. store.getScreensWithFingerprints({})   → all 1,040 screens (projected fields only)
  3. findSimilar(anchor, allScreens, opts)  → brute-force cosine/jaccard across 3 layers
  4. Enrich results with image_url
  ↓
Frontend renders result cards in a grid below the detail content
  ↓
User clicks a preset pill → re-fetch with new preset
User clicks a result card → navigates to that screen's detail page (standard #/screen/:id)
```

---

### What NOT to Do

- **Do NOT rewrite** `src/similarity.js` or `src/store.js` — they work, just import and call them
- **Do NOT add npm dependencies** — everything needed is already available (Express, Ractive, MongoDB)
- **Do NOT add a build step** — the frontend is vanilla JS served as static files
- **Do NOT cache allScreens permanently in the server** — for 1K screens the per-request load is fast enough. If you want to add a simple in-memory cache with a 5-minute TTL, that's fine but not required
- **Do NOT change the existing gallery or dashboard views** — this feature is scoped to the detail page only (with optional gallery hover action as nice-to-have)

---

### File Manifest

| File | Action | What Changes |
|---|---|---|
| `server.js` | MODIFY | Add `GET /api/similar/:screenId` endpoint, import `findSimilar` + `WEIGHT_PRESETS` from similarity.js |
| `frontend/js/app.js` | MODIFY | Add `api.similar()`, add `loadSimilar()` method, add preset pill toggle logic, add similar results rendering |
| `frontend/index.html` | MODIFY | Add similar results section to `#detail-template` partial (button + preset pills + results grid) |
| `frontend/css/app.css` | MODIFY | Add styles for preset pills, similarity badges, similar results section |

---

### Acceptance Criteria

1. **Detail page shows "Find Similar" button** — visible on every screen detail view
2. **Clicking it fetches and displays 12 similar screens** — as a card grid with similarity percentages
3. **4 preset pills work** — switching preset re-fetches with different weights, results visibly change
4. **Result cards are clickable** — navigating to the clicked screen's detail page
5. **Similarity scores display correctly** — total as percentage badge, color-coded (green/yellow/red)
6. **Loading state works** — spinner shown while fetching, detail page remains visible
7. **No regressions** — existing dashboard, gallery, and detail views work unchanged
8. **Response time < 500ms** — for the /api/similar endpoint on the current 1,040 screen dataset

---

### MongoDB Document Shape (Reference)

Each screen in the `screens` collection has this structure. The similarity engine reads `fingerprint`, `visual_features`, and `analysis.scores`:

```json
{
  "screen_id": "fintech_042",
  "industry": "fintech",
  "source": "reference",
  "file_path": "fintech/fintech_042.png",
  "analysis": {
    "screen_type": "dashboard",
    "platform": "ios",
    "scores": {
      "color_restraint": 7, "hierarchy_clarity": 8, "glanceability": 7,
      "density": 6, "whitespace_ratio": 7, "brand_confidence": 8,
      "calm_confident": 8, "bold_forward": 6, "overall_quality": 8,
      "calm_energetic": -2, "confident_tentative": -3,
      "forward_conservative": -1, "premium_accessible": 2, "warm_clinical": 1
    },
    "verdict": "Restrained palette with confident hierarchy...",
    "color_palette": { "dominant": ["#FFFFFF", "#1A1A2E"], "accent": "#4CAF50", "strategy": "complementary", "dark_mode": false },
    "typography": { "primary_style": "geometric_sans", "scale": "moderate", "weight_bias": "medium" },
    "spatial": { "layout": "dashboard", "density_feel": "balanced" }
  },
  "fingerprint": {
    "style_tags": ["minimal", "clean", "flat"],
    "design_mood": "calm",
    "color_temp": "cool",
    "has_hero_image": false, "has_bottom_nav": true, "has_top_bar": true,
    "has_cards": true, "has_icons": true, "has_illustrations": false,
    "has_gradient": false, "has_shadow": true, "has_dividers": true,
    "has_fab": false, "has_avatar": true
  },
  "visual_features": {
    "color_histogram": [48 floats],
    "spatial_color_map": [27 floats],
    "edge_density_map": [9 floats],
    "perceptual_hash": "a1b2c3d4e5f67890"
  },
  "score_vector": [14 floats],
  "cost": 0.0058,
  "tokens": { "input": 377, "output": 522, "cached": 1155 }
}
```

---

### Weight Presets (Reference)

```js
// From src/similarity.js
export const WEIGHT_PRESETS = {
  default:    { semantic: 0.35, visual: 0.40, score: 0.25 },
  visual:     { semantic: 0.15, visual: 0.65, score: 0.20 },  // "looks like"
  conceptual: { semantic: 0.55, visual: 0.20, score: 0.25 },  // "feels like"
  quality:    { semantic: 0.20, visual: 0.20, score: 0.60 },  // "scores like"
};
```

**Preset labels for UI:**
| Key | Display Label | Description (for tooltip) |
|---|---|---|
| `default` | Balanced | Equal weight across visual appearance, design concepts, and quality scores |
| `visual` | Looks Like | Prioritizes pixel-level visual similarity (colors, layout, density) |
| `conceptual` | Feels Like | Prioritizes design tags, mood, and structural fingerprint |
| `quality` | Scores Like | Prioritizes screens with similar quality and emotional scores |
