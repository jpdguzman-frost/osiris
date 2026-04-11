# F8 — Osiris Arena (Session Handoff)

> **This is a handoff doc, not the full PRD.** It captures the conversation state so a new Claude Code session can resume without re-litigating decisions. The full PRD is the next artifact to produce.

---

## The problem we're solving

The visual evaluation rubric (`config/rubric.md`) has known biases:

1. **Minimal-bias.** `color_restraint` is defined as "limited = high," which structurally penalizes colorful-but-strong screens. `calm_confident` as a core score rewards an aesthetic stance, not craft.
2. **Missing craft layer.** No metrics for alignment, spacing rhythm, optical alignment, line height, padding consistency, color harmony, or contrast.
3. **No anchors / no evidence.** Each score is a 1-line definition. No reference examples, no per-score justification. LLM judge collapses to ~6.5 ± noise.
4. **Cultural bias.** Sonnet 4.5 was trained on Western design (Stripe/Linear/Airbnb). Systematically penalizes Asian fintech aesthetics — exactly GCash's competitor set.
5. **Deterministic signals being paid for.** `src/fingerprint.js` already computes edge density, color histogram, spatial color map, perceptual hash. The rubric pays Claude to vibe-check things `sharp` could measure exactly.
6. **No temperature set** in `src/analyzer.js:173` — default 1.0 means every score has ±1 noise. One-line free fix.
7. **`similarity.js` hard-couples to current field names** — renaming core fields silently breaks retrieval across all 3,486 existing screens.

## The approach we agreed on

**Don't rewrite the rubric blind.** Build human ground truth first, then use it to diagnose the rubric and build anchors.

**Osiris Arena** = internal three-round game for the design team to produce a calibration dataset.

- **Round 1 — Tournament.** Pairwise elimination. Show two screens, user picks winner or skips. ELO ratings update live. Seeded from current rubric `overall_quality`. Matches made by visual similarity, not by labeled screen_type. Elimination: screens with 3+ losses and <2 wins get pruned. Session cap: 20–30 pairs.
- **Round 2 — Scoring.** Top ~200 winners from Round 1 scored 1–5 via single keystroke. One screen at a time.
- **Round 3 — Tagging.** Top ~50–100 winners tagged with up to 5 tags from a fixed list (~15 tags). Captures *why* a screen is good, becomes the vocabulary for the new rubric.

Multi-user. Google auth. Team plays async over ~1–2 weeks. Data aggregates continuously.

## Decisions locked in

| Question | Answer |
|---|---|
| Matching strategy | **Option A**: visual similarity matching (use existing `computeVisualSimilarity` from `src/similarity.js`). Screen type is unreliable due to mislabels. |
| Category cleanup | Skip button has a secondary "wrong category" flag. Screens flagged by multiple users queue for relabeling. Tournament doubles as label cleanup. |
| Auth | **Google OAuth** — already implemented in `src/auth.js`, restricted to `@frostdesigngroup.com`. Use existing `requireAuth` middleware. |
| Tag selection | User can pick **up to 5 tags per screen** in Round 3. Tag list is fixed (~15 tags). |
| Session size | 20–30 pairs per session, multiple sessions per user. |
| Session start | Seeded ELO from current rubric score, not from zero. |
| Pre-computation | Build a "visual neighbors" index once at launch — top 50 visually similar screens per screen — so matching is a lookup, not an O(n) cosine scan. |

## Data target

**Minimum viable** (across whole team):
- Round 1: ~1000 pairwise comparisons
- Round 2: ~150 top screens × 2 raters = ~300 scores
- Round 3: ~50 top screens × 2 raters = ~100 tag sets
- Per person: ~90 minutes total across all rounds

**Solid target**:
- Round 1: ~2000–2500 comparisons
- Round 2: 200 × 3 raters = 600 scores
- Round 3: 75 × 3 raters = 225 tag sets
- Per person: ~2.5 hours total

System should be useful after ~500 matches — ranking, disagreements, and bias scatter plot update live.

## What's already in the repo (don't rebuild)

- **Google OAuth**: `src/auth.js` — Passport + `passport-google-oauth20`. Domain-restricted to `frostdesigngroup.com`. Exports `requireAuth` middleware. Used in `server.js:59`.
- **Visual similarity**: `src/similarity.js:112` — `computeVisualSimilarity(vfA, vfB)` already combines edge density (0.45), spatial color (0.30), color histogram (0.25). Use directly for matching.
- **Fingerprint features**: `src/fingerprint.js` — every screen has `visual_features` with color_histogram (48f), spatial_color_map (27f), edge_density_map (9f), perceptual_hash. Stored on the screen doc.
- **Rubric scores**: every screen already has `analysis.scores.overall_quality` — use as seed ELO.
- **Store layer**: `src/store.js` — MongoDB wrapper. Add new collections following the existing pattern.
- **Frontend**: Ractive.js SPA at `frontend/`, no build step. Add new routes/views there.

## What needs to be built

### Backend
- **New collections**: `arena_matches`, `arena_scores`, `arena_tags`. `arena_users` optional — can derive from Google session.
- **New fields on `screens`**: `arena.elo`, `arena.wins`, `arena.losses`, `arena.skips`, `arena.category_flags`, `arena.active`, `arena.visual_neighbors` (pre-computed top 50), `arena.round2_avg`, `arena.round3_tags`.
- **Pre-compute script**: `scripts/arena-build-index.js` — compute top-50 visual neighbors for each of ~5000 screens once. Uses existing `computeVisualSimilarity`.
- **API endpoints** (all under `requireAuth`):
  - `GET /arena/match/next` — returns next pair for current user (matchmaking: pick a screen from active pool weighted by fewest-matches, then pick a neighbor from its pre-computed visual neighbors, filter by ELO proximity and user history)
  - `POST /arena/match` — submit result, update ELO, update win/loss counts, check elimination
  - `GET /arena/round2/next` + `POST /arena/round2`
  - `GET /arena/round3/next` + `POST /arena/round3`
  - `GET /arena/round3/tags` — return the fixed tag list
  - `GET /arena/leaderboard` — top N by ELO
  - `GET /arena/stats` — tournament progress
  - `GET /arena/biasmap` — scatter plot data: rubric `overall_quality` vs tournament ELO (the X-ray)
  - `GET /arena/disagreements` — contested pairs across users
  - `GET /arena/export` — final three-list calibration export
- **ELO**: K=32 for first 10 matches, K=16 after. Seed = `1000 + (overall_quality - 5) × 100`.

### Frontend
- `/arena/` — landing page with stats, "play round 1", "play round 2", "play round 3" buttons based on user progress
- `/arena/play` — Round 1 tournament view. Two screens side-by-side. Keyboard: ← → pick, space skip, 1/2 category-flag left/right. After 20-30 pairs, shows session summary.
- `/arena/score` — Round 2. One screen centered, 1-5 keys.
- `/arena/tag` — Round 3. One screen centered, tag grid below (click to toggle, max 5 selected), enter to submit.
- `/arena/admin` — stats, bias X-ray scatter, category flag review queue, exports.

### Round 3 tag list (draft — confirm before building)
1. Strong color use
2. Tasteful restraint
3. Clear hierarchy
4. Typographic craft
5. Spatial rhythm
6. Brand confidence
7. Density done right
8. Whitespace as design
9. Emotional warmth
10. Premium finish
11. Playful energy
12. Opinionated POV
13. Clever composition
14. Craft details
15. Information clarity

## What the tournament is supposed to produce

Not just "top screens." The real deliverable is **three lists plus a bias scatter plot**:

1. **Agreement winners** — rubric high, humans high. Confirm what's working.
2. **Hidden gems** — rubric low, humans high. *This is the colorful-strong bias, made visible.*
3. **False positives** — rubric high, humans low. *This is the minimal-lifeless bias, made visible.*
4. **Bias scatter plot** — X = rubric `overall_quality`, Y = tournament ELO. Dots off the diagonal are the disagreements. This is the X-ray.
5. **Tag frequency on winners** — the vocabulary for the new rubric.
6. **Category flag queue** — mislabeled screens to fix.
7. **Inter-rater disagreement pairs** — where the team's taste is uncertain.

Those outputs drive the *next* phase: rubric rewrite, few-shot reference images in the cached prompt, deterministic measurement of color/density/whitespace, and eventual re-scoring of the corpus on a 200-screen stratified sample first.

## Open items (to resolve before/during build)

1. **Tag list review** — confirm or edit the 15 tags above.
2. **Elimination threshold** — proposed: screens with 3 losses and <2 wins are removed from active pool. Reasonable? Too aggressive?
3. **Session-end rewards / gamification** — nothing fancy, but a "session summary" screen showing how many you voted on and the current leaderboard is motivating. Confirm scope.
4. **Admin who can see `/arena/admin`** — all logged-in users, or restrict to JP only? Proposal: all users, since the whole team is internal.
5. **Matchmaking for inter-rater overlap** — should the system intentionally repeat pairs across users to measure disagreement? Proposal: yes, 10% of pairs should be "repeat a pair another user has already voted on."
6. **Do we build the `arena_users` collection, or lean on the session cookie?** Proposal: tiny `arena_users` doc per Google user to track per-user stats and history. Simpler than querying matches collection every time.
7. **Mobile support?** Proposal: **no**. Desktop only. Designers play on laptops.

## Implementation order (rough)

1. Data model additions + migrations
2. `scripts/arena-build-index.js` — pre-compute visual neighbors (run once)
3. `src/arena.js` — matchmaking, ELO update, result recording
4. Backend routes in `server.js` (all wrapped in `requireAuth`)
5. Round 1 frontend page + keyboard handling
6. Round 2 frontend page
7. Round 3 frontend page
8. Admin page + bias scatter plot
9. Export endpoints
10. Polish, test, launch to team

## How to resume this in a new CLI session

Open Claude Code in the repo, then:

```
read docs/F8-arena-handoff.md and continue from the "Implementation order" section. we agreed to the plan, no need to re-debate the decisions. next step is to write the full PRD as docs/F8-arena-prd.md following the format of docs/F7-score-scatter-prd.md, then build. confirm any open items from the handoff before touching code.
```

That one prompt restores all the context. Claude will read this doc, skip the design debate, and start producing the PRD.

## Branch

All work happens on `claude/improve-visual-evaluation-8VjNT`.
