# Osiris — Design Intelligence Platform

Cross-industry visual design intelligence for **GCash** redesign. Collects UI screenshots from 6 industries (~3,400 screens), scores them with Claude Vision, and serves an interactive exploration app with similarity search, buckets, and scatter plots.

## Tech & Constraints
- **Node.js ES Modules** — `"type": "module"`, all `import/export`, no CommonJS, no TypeScript, no build step
- **Claude Sonnet 4.5** — vision analysis + text synthesis, prompt caching via ephemeral cache
- **MongoDB** — db: `osiris`, collections: `screens`, `buckets`, `distillations`
- **Express 5** — REST API (`server.js`), serves frontend + screen images
- **Frontend** — Ractive.js SPA (`frontend/`), no build step, served statically
- **Puppeteer + Cheerio + Sharp + node-fetch** — scraping & image processing

## Working Directory
`/Users/jpdguzman/Documents/Dev/osiris/`

## Architecture (3 Layers)

### 1. Pipeline Scripts (`scripts/`)
Batch processing stages — collect → analyze → ingest → fingerprint. Each stage is idempotent (checks for existing output). Scripts accept `--industry=automotive,luxury` to filter.

### 2. Express API (`server.js`, port 3000)
Routes: `/api/stats`, `/api/screens` (paginated + filtered), `/api/similar/:screenId` (3-layer fusion search), `/api/scatter`, `/api/buckets` (full CRUD), `/api/distillations`. Uses `BASE_PATH` env for reverse proxy.

### 3. Ractive.js Frontend (`frontend/`)
SPA with Dashboard, Screen Browser, Scatter Plot, Bucket views. CSS in `frontend/css/app.css`, logic in `frontend/js/app.js`.

## Key Modules (`src/`)
| Module | Purpose |
|---|---|
| `store.js` | MongoDB data layer — screens, buckets, distillations, indexes |
| `analyzer.js` | Claude Vision scoring (rubric from `config/rubric.md`) |
| `collector.js` | Puppeteer screenshots + Google CSE + Cheerio HTML extraction |
| `similarity.js` | 3-layer fusion search: semantic + visual + score, 4 weight presets |
| `fingerprint.js` | Color histogram (48-float) + spatial color map (27-float) vectors |
| `synthesizer.js` | Cross-industry pattern synthesis |
| `brief-generator.js` | 3 direction briefs (Calm+Confident, Bold+Forward, Opinionated) |
| `pattern-extractor.js` | UI component detection, cropping, clustering |
| `library-compiler.js` | HTML reference gallery builder |
| `utils.js` | `log*()` helpers, `CostTracker`, `promisePool()`, `PATHS`, `resizeForVision()` |

## Scoring System
- **Core (1-10):** overall_quality, calm_confident, bold_forward, color_restraint, hierarchy_clarity, glanceability, density, whitespace_ratio, brand_confidence
- **Spectrum (-5 to +5):** calm_energetic, confident_tentative, forward_conservative, premium_accessible, warm_clinical
- **Fingerprint tags:** style_tags, layout_type, screen_type, platform, design_mood, color_strategy — controlled vocab in `config/vocabularies.json`

## Data Flow
```
Screenshots (data/screens/{industry}/)
  → Claude Vision analysis (data/analysis/{industry}/*.json)
    → MongoDB ingest (screens collection)
      → Fingerprint vectors (stored in screen docs)
        → Express API → Ractive.js frontend
```

## Current State
- **Done:** Collection (~3,400 screens), Analysis (~3,486 JSONs), Ingest, HTML libraries (`output/library/`, `output/pattern-library/`)
- **Not run:** Synthesis (`data/synthesis/` empty), GCash Audit, Pattern Extraction, Direction Briefs
- **Deployed:** `aux.frostdesigngroup.com/osiris` via `deploy.sh` (rsync + PM2)

## Code Patterns
- `promisePool(items, concurrency, fn)` for bounded parallel work
- `PATHS` object from `utils.js` for all file paths — never hardcode
- `resizeForVision(path, 1568)` before sending images to Claude API
- `CostTracker` class tracks Sonnet 4.5 spend ($3/1M in, $15/1M out, $0.30/1M cached)
- Exponential backoff on API calls: 1s → 2s → 4s, max 60s, 3 attempts
- Logging: `logInfo()`, `logSuccess()`, `logWarn()`, `logError()`, `logProgress()`
- Keep style consistent with existing code — no linting config
- **Always run `/simplify` after completing code changes** — review for reuse, quality, and efficiency before considering the task done
- **When user says "deploy"**, run `./deploy.sh`
