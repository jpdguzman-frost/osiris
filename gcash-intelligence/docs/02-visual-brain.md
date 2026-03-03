# Requirements: Visual Brain — Feedback Loop & Application

## Overview

The Visual Brain is a self-improving design intelligence system. It ingests reference screenshots, distills the best patterns, synthesizes design principles, generates new screens via Figma, evaluates the results, and feeds them back into its memory. Each cycle produces better output because the system learns from its own generations.

The system also extracts discrete UI components from screens to build pattern libraries — reusable building blocks that inform generation alongside high-level principles.

---

## System Architecture

```
                    ┌─────────────────────────┐
                    │      APPLICATION UI      │
                    │   (Team Interface)        │
                    │                           │
                    │  Browse / Search / Distill│
                    │  View Patterns & Scores   │
                    │  Trigger Synthesis         │
                    │  Manage Generations        │
                    │  Compare Before/After      │
                    └───────────┬───────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
        ▼                       ▼                       ▼
┌──────────────┐   ┌───────────────────┐   ┌───────────────────┐
│   INGESTION  │   │    DISTILL +      │   │  PATTERN LIBRARY  │
│   ENGINE     │   │    SYNTHESIZE     │   │  ENGINE           │
│              │   │                   │   │                   │
│  Analyze     │   │  Query & Filter   │   │  Detect components│
│  Fingerprint │   │  Similarity Search│   │  Crop & describe  │
│  Store       │   │  Extract principles│  │  Cluster patterns │
│              │   │  Generate prompts │   │  Build library    │
└──────┬───────┘   └─────────┬─────────┘   └────────┬──────────┘
       │                     │                       │
       │                     ▼                       │
       │            ┌─────────────────┐              │
       │            │     FIGMA       │              │
       │            │  (MCP Desktop)  │              │
       │            │                 │              │
       │            │  Receive prompts│◀─────────────┘
       │            │  Generate screens│  (patterns inform
       │            │  Human refine   │   generation)
       │            └────────┬────────┘
       │                     │
       │                     │ Export screenshots
       │                     │ via API / MCP
       │                     ▼
       │            ┌─────────────────┐
       │            │    EVALUATE     │
       │            │                 │
       │            │  Re-analyze     │
       │            │  Score vs refs  │
       │            │  Diff report    │
       └────────────│  Store to memory│
                    │  generation: N+1│
                    └─────────────────┘

        ════════════════════════════════════════
                   MONGODB: "osiris"
          screens | patterns | syntheses |
          principles | generations | presets
        ════════════════════════════════════════
```

---

## Part 1: Feedback Loop Process

### Stage A: Distill

**Purpose:** From the full corpus (3,486+ reference screens + any generated screens), produce a curated subset optimized for a specific design intent.

**A.1** Distillation is query-driven. The team specifies an intent:
- "Top 50 screens for calm editorial fintech" (tags + scores + industry)
- "Screens similar to screen X" (similarity search)
- "All high-scoring dashboards across luxury and aerospace" (compound filter)
- Named presets for recurring distillation profiles

**A.2** Output: an ordered list of screen_ids with relevance/similarity scores.

**A.3** Distilled sets are saved as named collections in MongoDB for reuse:
```json
{
  "distillation_id": "calm_editorial_v1",
  "created_at": "2026-03-02T...",
  "query": { ... },
  "screen_ids": ["screen_001", "screen_042", ...],
  "count": 50,
  "notes": "For pitch deck direction 1"
}
```

**A.4** Distillation can combine multiple query types:
- Score thresholds AND tag filters AND similarity ranking
- Exclude previously used screens or specific industries
- Scope to a specific generation (reference only, or include gen-1 screens)

---

### Stage B: Synthesize

**Purpose:** From a distilled set, extract design principles with full cross-screen context. This is where principles live — not in per-screen analysis.

**B.1** Input: a distillation set (30-100 screens).

**B.2** Claude receives:
- The distilled screens' scores, verdicts, fingerprints, and color/type/spatial data
- The distillation query (so it understands the selection intent)
- Industry distribution of the set
- Optionally: pattern library excerpts from these screens

**B.3** Output: a synthesis document:
```json
{
  "synthesis_id": "syn_calm_editorial_v1",
  "distillation_id": "calm_editorial_v1",
  "created_at": "2026-03-02T...",
  "generation": 0,

  "principles": [
    {
      "rank": 1,
      "principle": "Actionable principle statement",
      "evidence_screens": ["screen_001", "screen_042"],
      "implementation": "How this translates to GCash",
      "dimensions_affected": ["whitespace_ratio", "calm_confident"]
    }
  ],
  "patterns_identified": [
    {
      "pattern": "Generous vertical rhythm with 24px+ section spacing",
      "frequency": "23 of 50 screens",
      "industries": ["luxury", "health", "editorial"]
    }
  ],
  "anti_patterns": [ ... ],
  "tension_resolution": "How to balance calm and bold",
  "fintech_gaps": [ ... ]
}
```

**B.4** Synthesis can be run multiple times on different distillations. Each synthesis is stored and versioned.

**B.5** Synthesis can operate in focused modes:
- **Dimension synthesis**: focused on color, typography, spatial, etc.
- **Holistic synthesis**: cross-cutting principles
- **Comparative synthesis**: compare two distillation sets (e.g., "what do luxury screens do that fintech screens don't?")

---

### Stage C: Generate (Principles → Prompts → Figma)

**Purpose:** Translate synthesis principles and pattern library references into structured prompts that drive Figma screen generation.

**C.1** A generation session is created:
```json
{
  "generation_id": "gen_001",
  "generation_number": 1,
  "synthesis_id": "syn_calm_editorial_v1",
  "created_at": "2026-03-02T...",
  "target_screens": ["home_dashboard", "send_money", "transaction_history"],
  "status": "in_progress",
  "screens_generated": []
}
```

**C.2** For each target screen, the system assembles a generation prompt:
- Principles from the synthesis (ranked, with implementation notes)
- Relevant patterns from the pattern library (e.g., navigation patterns, card patterns)
- Emotional targets (calm_confident weight, bold_forward weight, spectrum targets)
- Color direction, typography direction, spatial direction
- Reference screenshots (the distilled set that informed this direction)

**C.3** The prompt is sent to Figma via MCP Desktop Console tools.

**C.4** The design team can intervene, refine, iterate within Figma.

**C.5** When a generated screen is finalized, it is exported as a 356px-wide screenshot.

---

### Stage D: Evaluate

**Purpose:** Generated screens re-enter the ingestion engine. They are analyzed, scored, fingerprinted, and compared against reference screens.

**D.1** Generated screenshots are ingested with:
- `source: "generated"`
- `generation: N` (which feedback loop iteration)
- `generation_id: "gen_001"` (link to generation session)
- `synthesis_id: "syn_calm_editorial_v1"` (link to source synthesis)

**D.2** The Ingestion Engine runs the full pipeline: validate → analyze → fingerprint → store.

**D.3** After ingestion, an evaluation report is generated:
```json
{
  "evaluation_id": "eval_gen_001",
  "generation_id": "gen_001",
  "screens_evaluated": [
    {
      "screen_id": "gen_001_home_dashboard",
      "scores": { ... },
      "vs_reference_avg": {
        "calm_confident": "+1.2 above distillation avg",
        "overall_quality": "-0.5 below distillation avg"
      },
      "most_similar_reference": {
        "screen_id": "luxury_hermes_home_001",
        "similarity": 0.82
      },
      "principle_adherence": {
        "principles_met": 7,
        "principles_total": 10,
        "gaps": ["Insufficient whitespace in card section"]
      }
    }
  ],
  "generation_summary": {
    "avg_overall_quality": 7.8,
    "vs_previous_generation": "+0.4",
    "top_improvement": "Color restraint improved significantly",
    "top_regression": "Hierarchy clarity dropped in transaction history"
  }
}
```

**D.4** Generated screens are now part of the corpus. They appear in similarity searches, can be used as reference screens for the next cycle, and inform future distillations.

**D.5** The evaluation can trigger a new cycle: distill (including generated screens) → synthesize (with new context) → generate (improved) → evaluate.

---

### Stage E: Memory & Learning

**E.1** Every generation cycle adds to the corpus. The system tracks:
- Which principles produced high-scoring screens
- Which principles didn't translate well (generated screens scored lower than references on those dimensions)
- Score trajectories across generations (gen-0 avg → gen-1 avg → gen-2 avg)

**E.2** The `generations` collection tracks the full lineage:
```json
{
  "generation_number": 2,
  "parent_generation": 1,
  "synthesis_id": "syn_calm_editorial_v2",
  "distillation_included_generated": true,
  "improvements_over_parent": { ... },
  "regressions_from_parent": { ... }
}
```

**E.3** When synthesizing for generation N+1, Claude receives the evaluation report from generation N as additional context: "These principles worked well. These didn't. Adjust."

---

## Part 2: Pattern Library Engine

### Purpose

Extract discrete UI components from screens (nav bars, cards, hero sections, buttons, data visualizations, etc.) and build a searchable pattern library. These patterns serve as concrete building blocks for screen generation — not just "use generous whitespace" but "this specific card layout, these proportions, this spacing."

### PL-1: Component Detection

**PL-1.1** Input: a distilled set of screens (or the full corpus).

**PL-1.2** Claude Vision identifies discrete UI components per screen:
```json
{
  "component_id": "comp_001",
  "screen_id": "luxury_hermes_home_001",
  "industry": "luxury",
  "category": "card",
  "subcategory": "product_card_minimal",
  "label": "Minimal product card with image and single-line title",
  "description": "Full-width card, 16:9 image ratio, 16px padding, system font at 14px, no border, subtle shadow",
  "bbox": { "x": 5, "y": 32, "w": 90, "h": 25 },
  "design_qualities": {
    "calm_confident_score": 8,
    "bold_forward_score": 5,
    "craft": "high"
  }
}
```

**PL-1.3** Component categories (fixed enum):
```
navigation, card, hero, header, footer, button_group,
input_form, list_item, data_viz, balance_display,
tab_bar, search, modal, toast, empty_state,
onboarding_step, promotional_banner, avatar_group,
icon_system, status_indicator, qr_scanner
```

**PL-1.4** Claude outputs bounding boxes as percentage coordinates (relative to image dimensions) for resolution independence.

### PL-2: Component Cropping

**PL-2.1** Using bounding boxes from PL-1, Sharp crops each component from the source screenshot.

**PL-2.2** Crops saved to `data/patterns/crops/{industry}/{component_id}.png`.

**PL-2.3** Crops are fingerprinted (visual features) for pattern-level similarity search.

### PL-3: Pattern Clustering

**PL-3.1** Components of the same category are clustered by similarity (visual + description).

**PL-3.2** Clusters represent "pattern types": e.g., 15 different navigation bar implementations clustered into 4 distinct patterns.

**PL-3.3** Each cluster gets a summary:
```json
{
  "cluster_id": "nav_pattern_01",
  "category": "navigation",
  "pattern_name": "Minimal top bar with centered logo",
  "example_count": 12,
  "industries": ["luxury", "health", "automotive"],
  "avg_calm_score": 8.1,
  "avg_bold_score": 4.2,
  "representative_component_id": "comp_042",
  "description": "Thin top bar (48-56px), centered brand mark, icon-only actions left/right, no background fill"
}
```

### PL-4: Pattern Library as Generation Input

**PL-4.1** When generating screens via Figma, the system includes relevant patterns:
- "For the navigation bar, reference these 3 patterns from luxury and health"
- "For the card layout, reference this cluster of minimal product cards"

**PL-4.2** Patterns are selected based on the synthesis direction: calm_confident direction pulls from luxury/health clusters, bold_forward pulls from aerospace/automotive clusters.

**PL-4.3** Pattern references include both the visual crop AND the structured description, so Figma prompts have both "this is what it looks like" and "this is the spec."

### PL-5: Storage

**PL-5.1** Collection: `component_patterns` — individual detected components.

**PL-5.2** Collection: `pattern_clusters` — clustered pattern types.

**PL-5.3** Patterns link back to source screens via `screen_id`.

---

## Part 3: Application Requirements

### Overview

Replace the current HTML gallery (`library-compiler.js` → static HTML) with a proper application that the team can use for the full workflow: browse, search, distill, synthesize, manage generations, and explore patterns.

### APP-1: Technology Choice

**APP-1.1** Server: Node.js (Express or Fastify), consistent with existing stack.

**APP-1.2** Frontend: To be determined — options:
- (a) React/Next.js (rich interactivity, component ecosystem)
- (b) Svelte/SvelteKit (lighter, faster builds)
- (c) Vanilla HTML + htmx (minimal deps, server-rendered, fast to build)
- (d) Vue/Nuxt

**APP-1.3** The app connects to the same MongoDB `osiris` database.

**APP-1.4** The app runs locally (not deployed to cloud). Team accesses via `localhost`.

### APP-2: Core Screens / Views

**APP-2.1 — Corpus Browser**
- Grid/list view of all screens with thumbnails
- Filter sidebar: industry, source, generation, screen type, platform, score ranges, tags
- Sort by any score, by date, by similarity to a selected screen
- Click screen → detail view with full scores, fingerprint, verdict, visual features

**APP-2.2 — Similarity Explorer**
- Select a reference screen → see ranked similar screens with similarity breakdown
- Text search box → find screens by concept ("editorial dark mode dashboard")
- Toggle weight presets (visual, conceptual, quality, default)
- Visual comparison mode: side-by-side reference + similar screens

**APP-2.3 — Distillation Workbench**
- Build compound queries with visual query builder (dropdowns, sliders, tag chips)
- Preview results in real-time as filters are adjusted
- Save as named distillation preset
- Export distillation as JSON or start synthesis from it

**APP-2.4 — Synthesis & Principles View**
- List of synthesis runs with metadata
- View principles from any synthesis, ranked
- See which screens provided evidence for each principle
- Compare principles across synthesis runs

**APP-2.5 — Pattern Library**
- Browse patterns by category (navigation, card, hero, etc.)
- View pattern clusters with representative crops
- Filter by industry, quality score, design direction
- Click pattern → see all instances across screens with crops

**APP-2.6 — Generation Dashboard**
- Track generation cycles (gen-0, gen-1, gen-2, ...)
- View evaluation reports: score comparisons, improvements, regressions
- Score trajectory charts across generations
- Side-by-side: reference screen vs generated screen for same screen type

**APP-2.7 — Figma Bridge**
- Trigger generation prompt assembly for a synthesis + target screen type
- View the prompt that will be sent to Figma
- Receive screenshots back from Figma (via file drop, API endpoint, or MCP)
- Trigger evaluation pipeline on received screenshots

### APP-3: API Endpoints

**APP-3.1** The application exposes a REST API that the Figma integration (and other tools) can call:

```
GET  /api/screens                    — List/filter screens
GET  /api/screens/:id                — Get screen detail
GET  /api/screens/:id/similar        — Get similar screens
GET  /api/search?q=editorial         — Text search
POST /api/distill                    — Create distillation
GET  /api/distillations              — List saved distillations
GET  /api/distillations/:id          — Get distillation detail
POST /api/synthesize                 — Trigger synthesis on a distillation
GET  /api/syntheses                  — List synthesis runs
GET  /api/syntheses/:id              — Get synthesis with principles
GET  /api/patterns                   — List/filter patterns
GET  /api/patterns/clusters          — List pattern clusters
POST /api/generations                — Create generation session
GET  /api/generations/:id            — Get generation detail + evaluation
POST /api/generations/:id/evaluate   — Trigger evaluation on generated screens
POST /api/ingest                     — Ingest a new screenshot (from Figma or upload)
GET  /api/stats                      — Corpus statistics
```

**APP-3.2** The `POST /api/ingest` endpoint is the primary integration point for the Figma feedback loop. It accepts:
- A screenshot file (multipart upload)
- Metadata: source, generation_id, synthesis_id, screen_type, notes
- Triggers the full ingestion pipeline (analyze → fingerprint → store)
- Returns the analysis result

**APP-3.3** Authentication: none required for local use. Add a simple API key if the team needs remote access.

### APP-4: Figma Integration

**APP-4.1** Figma MCP Desktop Console tools are used to:
- Push generation prompts into Figma
- Potentially read back design properties

**APP-4.2** Screenshot export from Figma → app can happen via:
- Manual file drop in the app UI
- POST to `/api/ingest` endpoint
- Figma plugin that exports and sends to the API
- MCP tool chain

**APP-4.3** The app provides a "ready to evaluate" queue where uploaded Figma screenshots await evaluation pipeline processing.

---

## Part 4: MongoDB Collections (Complete)

```
screens              — All screens (reference + generated), full analysis + fingerprint
component_patterns   — Individual detected UI components with bboxes
pattern_clusters     — Clustered pattern types
distillations        — Saved distillation queries and results
syntheses            — Synthesis outputs with principles
generations          — Generation session tracking
evaluations          — Evaluation reports comparing generated vs reference
```

---

## Part 5: Implementation Phases

### Phase 1: Ingestion Engine (This document's Part 1)
- Lean analyzer (new rubric, ~700 output tokens)
- Visual feature extraction (fingerprint.js)
- Similarity search (similarity.js)
- Distillation queries (distill.js)
- CLI scripts for all of the above
- Process all 3,486 reference screens

### Phase 2: Pattern Library Engine
- Component detection via Claude Vision
- Crop extraction via Sharp
- Pattern clustering
- MongoDB storage for patterns
- CLI scripts

### Phase 3: Application — Core Browse & Search
- API server setup (Express/Fastify)
- Frontend scaffolding (framework TBD)
- Corpus browser view
- Similarity explorer view
- Distillation workbench

### Phase 4: Application — Synthesis & Generation
- Synthesis trigger & viewer
- Generation prompt assembly
- Figma bridge (MCP integration)
- Evaluation pipeline

### Phase 5: Feedback Loop
- Generation dashboard
- Score trajectory tracking
- Cross-generation comparison
- Self-improving synthesis (evaluation context fed into next cycle)

### Phase 6: Refinement
- Weight tuning for similarity search
- Pattern library quality improvement
- Prompt optimization for Figma generation
- Performance optimization if corpus grows significantly
