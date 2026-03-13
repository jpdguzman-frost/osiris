# Osiris MCP Server — Design Intelligence for Claude

Cross-industry visual design intelligence, accessible as MCP tools. Claude reads curated design intelligence from Osiris buckets, designs in Figma via Figma Desktop MCP, self-evaluates against the same rubric Osiris uses, and iterates until the quality bar is met.

## Architecture

**MCP server over HTTP** — the Osiris API is already deployed at `aux.frostdesigngroup.com/osiris`. The MCP server is a thin local process that translates MCP tool calls into HTTP GETs against that API. No SSH tunnels, no direct MongoDB, no new infrastructure.

```
Claude Code ←stdio→ Osiris MCP Server ←HTTP→ aux.frostdesigngroup.com/osiris/api/*
Claude Code ←stdio→ Figma Desktop MCP ←→ Figma
```

**Files:**
```
mcp-server/
├── index.js       # MCP server (single file, ES Module, stdio transport)
├── package.json   # @modelcontextprotocol/sdk, zod
└── README.md
```

## Setup

```bash
cd mcp-server && npm install
```

Register with Claude Code (project settings at `~/.claude/projects/.../settings.json`):

```json
{
  "mcpServers": {
    "osiris": {
      "command": "node",
      "args": ["/path/to/osiris/mcp-server/index.js"]
    }
  }
}
```

Or via CLI:
```bash
/mcp add osiris node /path/to/osiris/mcp-server/index.js
```

## Testing

**MCP Inspector:**
```bash
npx @modelcontextprotocol/inspector node index.js
```

**In Claude Code** (after registering):
- "List the Osiris buckets" → calls `osiris_list_buckets`
- "Show me insights for [bucket name]" → calls `osiris_get_bucket_insights`

## Tools

### Slice 1 — Read Buckets and Insights

| Tool | Calls | Returns |
|------|-------|---------|
| `osiris_list_buckets` | `GET /api/buckets` | Bucket names, IDs, counts, whether insights exist |
| `osiris_get_bucket_insights` | `GET /api/buckets/:id` | editorial_summary, mood_summary, patterns[], insights[], recommendations[], avg scores |
| `osiris_get_bucket_screens` | `GET /api/buckets/:id?sort=overall_quality&limit=12` | Top screens with scores, fingerprints, verdicts, image URLs |

**Unlocks:** Claude can read Osiris intelligence. Foundation for everything else.

### Slice 2 — Osiris-Informed Figma Design (Manual Loop)

No new code — workflow test using Slice 1 tools + existing Figma Desktop MCP tools (`figma_execute`, `figma_take_screenshot`, `figma_create_child`, `figma_set_fills`, `figma_set_text`, etc.).

**Test:**
1. Open a blank Figma file
2. Prompt: "Query the [bucket name] bucket and design a premium onboarding screen in Figma based on what you learn."
3. Verify Claude: (a) calls Osiris tools first, (b) references specific patterns in its reasoning, (c) creates Figma elements, (d) screenshots to show you

**Pivot point:** If bucket insights aren't actionable enough for design, we know before writing more code.

### Slice 3 — Screen Detail + Scoring Rubric + Benchmarks

| Tool | Source | Returns |
|------|--------|---------|
| `osiris_get_screen_detail` | `GET /api/screens/:id` | Full screen analysis — scores, verdict, color palette, fingerprint, image_url |
| `osiris_get_scoring_rubric` | Reads `config/rubric.md` from disk | The scoring dimensions and scale definitions |
| `osiris_get_bucket_benchmarks` | `GET /api/buckets/:id` → extract `metadata.stats` | avg_quality, avg_calm, avg_bold — the bar to meet |

**Unlocks:** Claude now has: what to measure (rubric), what to beat (benchmarks), and what good looks like (screen references).

### Slice 4 — Self-Evaluation Loop

| Tool | Source | Returns |
|------|--------|---------|
| `osiris_score_comparison` | Pure computation (no API call) | Formatted scorecard comparing design scores vs benchmarks, highlighting gaps |

**Prompt pattern** for the closed loop:
```
After designing in Figma:
1. Take a screenshot (figma_take_screenshot)
2. Score it against the Osiris rubric (osiris_get_scoring_rubric)
3. Compare scores to bucket benchmarks (osiris_get_bucket_benchmarks → osiris_score_comparison)
4. If any core metric is >1pt below benchmark, identify weakness and iterate
5. Present final design with scorecard: your scores vs benchmarks
```

**Unlocks:** The full closed loop — an AI design partner that reads intelligence, designs, and self-corrects.

### Slice 5 — Exploration Tools

| Tool | Calls | Returns |
|------|-------|---------|
| `osiris_find_similar` | `GET /api/similar/:screenId` | Similar screens across the full database |
| `osiris_search_screens` | `GET /api/screens?industry=X&sort=Y&limit=Z` | Filtered screen search |

**Unlocks:** Creative flexibility — Claude can explore beyond curated buckets.

## End-to-End Verification (after all slices)

1. Open Figma with a blank file
2. "Design a send-money screen for GCash. Reference the [bucket]. Self-evaluate and iterate until you meet benchmarks."
3. Claude queries bucket → designs in Figma → screenshots → self-scores → compares to benchmarks → iterates → presents final design with scorecard
4. You direct: "Push bolder" or "Give me 3 nav variants" → Claude adjusts, re-evaluates

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `OSIRIS_API_BASE` | `https://aux.frostdesigngroup.com/osiris` | API endpoint |

## Summary

| Slice | What | Code? | You have after |
|-------|------|-------|----------------|
| **1** | MCP server: read buckets | Yes | Osiris accessible to Claude |
| **2** | Workflow: insights → Figma | No — prompt only | Data-to-design validated |
| **3** | Tools: screen detail, rubric, benchmarks | Yes — 3 tools | Evaluation vocabulary |
| **4** | Self-eval loop + score comparison | Yes — 1 tool + prompt | Full closed loop |
| **5** | Exploration: similar, search | Yes — 2 tools | Creative flexibility |
