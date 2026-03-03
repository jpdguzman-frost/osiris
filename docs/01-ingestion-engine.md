# Requirements: Ingestion Engine

## Overview

The Ingestion Engine is the entry point for all visual data into the Osiris Visual Brain. Every screenshot — whether a reference screen from the wild, a curated hand-pick, or a Figma-generated design — enters the system through this engine. It produces a standardized, searchable representation of each screen that enables similarity search, distillation, and downstream synthesis.

---

## System Context

```
Screenshots (356px wide, proportional height)
     │
     ▼
┌──────────────────────────────────────────────────┐
│              INGESTION ENGINE                     │
│                                                   │
│  1. Validate & Normalize                          │
│  2. Analyze (Claude Vision → lean structured JSON)│
│  3. Fingerprint (Sharp → visual feature vector)   │
│  4. Store (MongoDB → screens collection)          │
│                                                   │
└──────────────┬───────────────────────────────────┘
               │
               ▼
         MongoDB: screens collection
         (scores + fingerprint + visual features)
               │
               ▼
         Queryable by: similarity, text, scores,
         screen type, industry, tags, components
```

---

## Functional Requirements

### FR-1: Image Validation & Normalization

**FR-1.1** Accept image formats: JPEG, PNG, WebP, GIF.

**FR-1.2** Validate minimum dimensions: width >= 200px, height >= 200px.

**FR-1.3** All input screenshots are pre-normalized by the team to 356px width with proportional height. The engine should verify this and log warnings for non-conforming images but still process them.

**FR-1.4** For Claude Vision API submission, resize to max 1568px on longest edge (existing behavior). Since inputs are 356px wide, most will pass through without resize.

**FR-1.5** Compute SHA-256 hash (first 16 chars) for deduplication. Skip analysis if a screen with the same hash already exists in MongoDB.

**FR-1.6** Accept a `source` tag on ingestion: `reference`, `curated`, `generated`, `gcash_current`. This tracks where the screen came from.

---

### FR-2: Screen Analysis (Claude Vision)

The analysis call produces a lean, structured JSON per screen. Optimized for cost at scale (3,486+ screens).

**FR-2.1** Model: `claude-sonnet-4-5-20250929` (or configurable).

**FR-2.2** System prompt (rubric) cached via Anthropic ephemeral cache control.

**FR-2.3** Target output: ~700 tokens per screen (down from ~2,500 in current implementation).

**FR-2.4** `max_tokens` set to 1500 (headroom but prevents runaway output).

**FR-2.5** Output schema:

```json
{
  "scores": {
    "color_restraint": 0,
    "hierarchy_clarity": 0,
    "glanceability": 0,
    "density": 0,
    "whitespace_ratio": 0,
    "brand_confidence": 0,
    "calm_confident": 0,
    "bold_forward": 0,
    "overall_quality": 0,
    "calm_energetic": 0,
    "confident_tentative": 0,
    "forward_conservative": 0,
    "premium_accessible": 0,
    "warm_clinical": 0
  },
  "verdict": "One sentence.",
  "fingerprint": {
    "style_tags": ["editorial", "minimalist", "dark-mode"],
    "layout_type": "single_column_editorial",
    "design_mood": "calm_sophisticated",
    "color_temp": "cool",
    "typeface_class": "humanist_sans",
    "has_hero": false,
    "has_cards": true,
    "has_nav_bar": true,
    "has_bottom_bar": false,
    "has_search": false,
    "has_data_viz": false,
    "has_carousel": false,
    "has_fab": false,
    "has_illustration": false,
    "has_photography": true,
    "has_avatar": false
  },
  "color_palette": {
    "dominant": ["#hex1", "#hex2", "#hex3"],
    "accent": "#hex",
    "strategy": "neutral_plus_accent",
    "dark_mode": false
  },
  "typography": {
    "primary_style": "geometric_sans",
    "scale": "generous",
    "weight_bias": "light_dominant"
  },
  "spatial": {
    "layout": "card_grid",
    "density_feel": "balanced"
  },
  "screen_type": "dashboard",
  "platform": "ios"
}
```

**FR-2.6** Scores use the same scales as existing:
- Core metrics: 1-10 (integer or one decimal)
- Emotional spectrum: -5 to +5

**FR-2.7** `fingerprint.style_tags`: 3-7 tags from a controlled vocabulary (defined in config). Enum-heavy, no free-text prose.

**FR-2.8** `fingerprint.layout_type`: One value from a fixed enum.

**FR-2.9** `fingerprint.design_mood`: One value from a fixed enum.

**FR-2.10** All component flags (`has_*`) are booleans.

**FR-2.11** No `principles_extracted` in per-screen analysis. Principles are generated at synthesis stage with cross-screen context.

**FR-2.12** No `identity_signals` in per-screen analysis. Redundant with style_tags + verdict.

**FR-2.13** Retry logic: exponential backoff, 1s → 2s → 4s, max 60s, 3 attempts.

**FR-2.14** JSON parsing with fallback: try direct parse, then regex extract from markdown fences.

**FR-2.15** Validation: response must contain `scores.overall_quality` as a number. Reject and retry otherwise.

---

### FR-3: Visual Feature Extraction (Sharp — Layer 2)

Pure compute, zero API cost. Extracts a dense numeric vector from pixel data.

**FR-3.1** Color Histogram (48 dimensions):
- Resize to 128x128 (fill mode)
- 16 bins per RGB channel
- Normalize each channel to sum to 1.0

**FR-3.2** Spatial Color Map (27 dimensions):
- 3x3 grid overlay on 128x128 resize
- Average RGB per cell, normalized to [0, 1]

**FR-3.3** Edge Density Map (9 dimensions):
- Grayscale → Laplacian convolution (Sharp `convolve`)
- 3x3 grid, proportion of edge pixels per cell (threshold > 30)

**FR-3.4** Perceptual Hash (64-bit dHash):
- Resize to 9x8 grayscale
- Horizontal gradient comparison
- Stored as 16-char hex string
- Used for near-duplicate detection (Hamming distance < 5)

**FR-3.5** Total visual feature vector: 84 dimensions (48 + 27 + 9).

**FR-3.6** Processing target: < 100ms per image at 356px width.

**FR-3.7** Use `promisePool` with concurrency of 10 (CPU-bound, no API limits).

---

### FR-4: Score Vector Assembly (Layer 3)

**FR-4.1** Assemble the 14 existing scores into a normalized vector:
- Core metrics (1-10): normalize to [0, 1] by dividing by 10
- Emotional spectrum (-5 to +5): normalize to [0, 1] via `(value + 5) / 10`

**FR-4.2** This is a reshape of existing data, not a new computation.

---

### FR-5: MongoDB Storage

**FR-5.1** Collection: `screens` (same as current, extended schema).

**FR-5.2** Document schema:

```json
{
  "screen_id": "string (unique)",
  "industry": "string",
  "source": "reference | curated | generated | gcash_current",
  "source_url": "string (optional)",
  "file_path": "string",
  "file_hash": "string (16-char SHA-256 prefix)",
  "analyzed_at": "ISO 8601 timestamp",
  "generation": 0,

  "analysis": {
    "scores": { ... },
    "verdict": "string",
    "color_palette": { ... },
    "typography": { ... },
    "spatial": { ... },
    "screen_type": "string",
    "platform": "string"
  },

  "fingerprint": {
    "style_tags": ["string"],
    "layout_type": "string",
    "design_mood": "string",
    "color_temp": "string",
    "typeface_class": "string",
    "has_hero": "boolean",
    "has_cards": "boolean",
    ...
  },

  "visual_features": {
    "color_histogram": [48 floats],
    "spatial_color_map": [27 floats],
    "edge_density_map": [9 floats],
    "perceptual_hash": "16-char hex"
  },

  "score_vector": [14 floats, normalized 0-1],

  "tokens": { "input": 0, "output": 0, "cached": 0 },
  "cost": 0.0
}
```

**FR-5.3** `generation` field: 0 for reference/curated screens, 1+ for generated screens (tracks which feedback loop iteration produced it).

**FR-5.4** Indexes:
- `screen_id` (unique)
- `industry`
- `source`
- `generation`
- `fingerprint.style_tags`
- `fingerprint.layout_type`
- `fingerprint.design_mood`
- `analysis.scores.overall_quality`
- `analysis.scores.calm_confident`
- `analysis.scores.bold_forward`
- `analysis.screen_type`
- `visual_features.perceptual_hash`

---

### FR-6: Similarity Search

**FR-6.1** Three-layer fusion similarity:

```
similarity(A, B) = w1 * semantic_sim + w2 * visual_sim + w3 * score_sim
```

Default weights: `{ semantic: 0.4, visual: 0.3, score: 0.3 }`

**FR-6.2** Semantic similarity (Layer 1):
- Style tags: Jaccard index
- Layout type: binary match (1.0 or 0.0)
- Design mood: binary match (1.0 or 0.0)
- Component flags: cosine similarity on boolean vector
- Combined: `0.4 * jaccard + 0.2 * layout + 0.15 * mood + 0.25 * flags`

**FR-6.3** Visual similarity (Layer 2):
- L2-normalize each sub-vector (histogram, spatial, edge) independently
- Concatenate into 84-dim vector
- Cosine similarity

**FR-6.4** Score similarity (Layer 3):
- Cosine similarity on the 14-dim normalized score vector

**FR-6.5** Image-to-image search: given a screen_id, find top-K most similar screens.

**FR-6.6** Text-to-image search: given a text query (e.g., "editorial minimalist"), match against:
- Style tags (exact + fuzzy match via synonym map)
- Layout type enum
- Design mood enum
- Score profile mapping (e.g., "editorial" → high whitespace, low density)

**FR-6.7** Combined search: text filter → subset, then rank by image similarity within subset.

**FR-6.8** Weight presets:
- `default`: `{ semantic: 0.4, visual: 0.3, score: 0.3 }`
- `visual`: `{ semantic: 0.2, visual: 0.6, score: 0.2 }` — "looks like this"
- `conceptual`: `{ semantic: 0.6, visual: 0.1, score: 0.3 }` — "same design approach"
- `quality`: `{ semantic: 0.2, visual: 0.2, score: 0.6 }` — "similar design quality"

**FR-6.9** Brute-force search (no ANN index). At 3,486 screens × 84 dimensions, query time < 50ms. Revisit if corpus exceeds 50,000 screens.

**FR-6.10** Results include explanation metadata: which tags matched, color similarity score, closest score dimensions.

---

### FR-7: Distillation Queries

**FR-7.1** Filter by any combination of:
- Industry
- Source type (reference, curated, generated)
- Generation number
- Score thresholds (e.g., `calm_confident >= 7`)
- Screen type (dashboard, onboarding, etc.)
- Platform (ios, android, web)
- Style tags (contains any/all of given tags)
- Layout type
- Design mood
- Component flags (has_hero = true, etc.)

**FR-7.2** Sort by any score field, similarity to a reference screen, or composite.

**FR-7.3** Limit/offset pagination.

**FR-7.4** Named distillation presets (saved queries):
- "Calm editorial fintech" → `calm_confident >= 7, style_tags includes editorial, industry in [fintech, luxury]`
- "Bold dashboards" → `bold_forward >= 7, layout_type = dashboard`
- Custom presets saveable to config.

---

### FR-8: Controlled Vocabularies (Config)

**FR-8.1** `config/vocabularies.json`:

```json
{
  "style_tags": [
    "minimalist", "editorial", "bold", "playful", "corporate",
    "luxury", "brutalist", "glassmorphism", "neumorphism",
    "flat", "material", "dark-mode", "illustration-driven",
    "photography-driven", "data-dense", "card-based", "immersive",
    "utilitarian", "premium", "vibrant", "muted", "monochromatic",
    "high-contrast", "rounded", "sharp-edges", "organic", "geometric",
    "futuristic", "retro", "clean", "dense", "spacious",
    "serif-dominant", "sans-dominant", "display-type",
    "gradient-heavy", "duotone", "split-screen", "full-bleed"
  ],
  "layout_types": [
    "single_column", "two_column", "card_grid", "list",
    "dashboard", "editorial", "hero_plus_list", "split_screen",
    "full_bleed", "tabbed", "feed", "form_centric",
    "onboarding_flow", "modal_overlay", "data_table"
  ],
  "design_moods": [
    "calm_sophisticated", "bold_energetic", "warm_friendly",
    "cool_professional", "playful_vibrant", "minimal_austere",
    "premium_luxurious", "utilitarian_functional"
  ],
  "typeface_classes": [
    "geometric_sans", "humanist_sans", "neo_grotesque",
    "serif", "slab_serif", "monospace", "display"
  ],
  "color_strategies": [
    "monochromatic", "analogous", "complementary",
    "triadic", "neutral_plus_accent", "duotone"
  ],
  "screen_types": [
    "home", "dashboard", "detail", "list", "settings",
    "onboarding", "checkout", "product", "profile",
    "search", "feed", "chat", "map", "camera",
    "payment", "transfer", "history", "notification"
  ],
  "platforms": [
    "ios", "android", "web_desktop", "web_mobile",
    "tv", "automotive", "wearable", "unknown"
  ]
}
```

**FR-8.2** Vocabularies are versioned. When updated, existing screens are NOT automatically re-tagged (would require re-analysis). New vocabulary entries apply to new screens only.

**FR-8.3** The Claude prompt for analysis references these vocabularies explicitly, constraining output to valid values.

---

### FR-9: Cost Constraints

**FR-9.1** Target per-screen analysis cost: **< $0.02** (with cached rubric).

**FR-9.2** Budget cap configurable via `BUDGET_CAP` env var.

**FR-9.3** Budget tracking with warnings at 50%, 75%, 90%.

**FR-9.4** Cost breakdown per screen logged: input tokens, output tokens, cached tokens, cost.

**FR-9.5** Estimated total for 3,486 screens: **~$50-60** (analysis) + **$0** (visual features).

---

### FR-10: CLI Interface

**FR-10.1** `npm run analyze` — Run Claude Vision analysis on un-analyzed screens.
- `--industry=automotive,luxury` — filter by industry
- `--source=reference` — filter by source type
- `--concurrency=5` — override default concurrency
- `--dry-run` — estimate cost without running

**FR-10.2** `npm run fingerprint` — Extract visual features for analyzed screens lacking them.
- `--industry=automotive` — filter
- `--force` — re-extract even if features exist

**FR-10.3** `npm run search` — Similarity search.
- `--similar-to=screen_id` — image-to-image search
- `--query="editorial minimalist"` — text-to-image search
- `--weights=visual` — weight preset
- `--top=20` — result count
- `--industry=fintech` — scope search
- `--min-score=7` — quality threshold

**FR-10.4** `npm run distill` — Compound query with multiple filters.
- `--tags=editorial,minimalist`
- `--screen-type=dashboard`
- `--calm-confident-min=7`
- `--layout=card_grid`
- `--limit=50`
- `--sort=overall_quality`
- `--preset=calm_editorial_fintech`

**FR-10.5** `npm run stats` — Corpus statistics (counts by industry, source, generation, score distributions).

**FR-10.6** `npm run ingest` — Import analysis JSONs into MongoDB (for backward compatibility or batch import).

---

### FR-11: Idempotency & Resume

**FR-11.1** Analysis checks for existing output JSON before re-running (current behavior, keep).

**FR-11.2** Visual feature extraction checks for existing `visual_features` in MongoDB document.

**FR-11.3** Full pipeline can be interrupted and resumed without re-processing completed screens.

**FR-11.4** `--force` flag on any command overrides idempotency checks.

---

## Non-Functional Requirements

**NFR-1** Pure Node.js ES Modules. No TypeScript. No build step.

**NFR-2** All async operations use async/await. No callbacks.

**NFR-3** Logging with emoji prefixes via existing `utils.js` helpers.

**NFR-4** Concurrency controlled via `promisePool`: 5 for API calls, 10 for local compute.

**NFR-5** MongoDB connection reuse (single connection per script run).

**NFR-6** Graceful shutdown: close MongoDB connection on process exit.

---

## File Structure (New/Modified)

```
src/
  analyzer.js          # MODIFIED — new lean rubric, reduced max_tokens
  fingerprint.js       # NEW — visual feature extraction (Sharp)
  similarity.js        # NEW — 3-layer fusion search engine
  store.js             # MODIFIED — new indexes, fingerprint storage, query methods
  utils.js             # EXISTING — no changes expected

scripts/
  analyze.js           # EXISTING — may need flag updates
  fingerprint.js       # NEW — batch visual feature extraction CLI
  search.js            # NEW — similarity search CLI
  distill.js           # NEW — compound query CLI
  ingest.js            # EXISTING — update for new schema

config/
  rubric.md            # REWRITTEN — lean output schema, ~700 token target
  vocabularies.json    # NEW — controlled enums for tags, layouts, moods
  industries.json      # EXISTING — no changes
```

---

## Cost Model

| Item | Per Screen | 3,486 Screens |
|---|---|---|
| Claude Vision (cached rubric, ~700 output tokens) | ~$0.015 | ~$52 |
| Visual feature extraction (Sharp, local) | $0 | $0 |
| Score vector assembly | $0 | $0 |
| MongoDB storage (~2KB fingerprint per doc) | $0 | ~7MB total |
| Similarity search (brute-force, in-memory) | $0 | $0 |
| **Total** | **~$0.015** | **~$52** |

Previous architecture would have cost ~$146 for the same corpus. **64% savings.**
