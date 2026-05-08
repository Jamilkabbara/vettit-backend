# Pass 35 B1 + B2 — Audience Profiling + Market Entry: deferred to Pass 36

**Date:** 2026-05-08
**Reason:** Each methodology requires multi-week implementation;
honest deferral instead of half-built UX.

## What B1 + B2 actually require

Both methodologies were mock-marked as `comingSoon: true` in Pass 34
B4 to keep the /setup grid honest with /methodologies. Pass 35 spec
asked for FULL implementation. Real scope per methodology:

### B1 — Audience Profiling
- Schema migration: 4 columns (`audience_dimensions`,
  `audience_segment_count`, `audience_methodology`, `segments_output`)
- Question generator: 18-22 questions across attitudinal /
  behavioral / needs / media / demographic batteries
- Setup component: `AudienceProfilingInputs.tsx` with multi-select
  dimensions + segment count slider + sample-size guidance card
- Server-side cluster analysis post-completion:
  - Standardize numeric features (z-score)
  - One-hot encode categoricals
  - K-means with `ml-kmeans` package (NEW dependency)
  - Mean attribute scores + demographic skew per cluster
  - Sonnet generates persona name + description per cluster
  - Write to `segments_output` JSONB
- Sample-size enforcement: reject < 300 with directional-only flag
- Results page: hero + segment cards + radar chart per segment +
  targeting recommendation card
- /methodologies page promotion (SOON → LIVE)
- llms.txt update

Estimated effort: 3-5 days dedicated work, 6-8 atomic commits.

### B2 — Market Entry
- Schema migration: 3 columns (`market_entry_source`,
  `market_entry_considerations`, `market_entry_methodology`)
- Question generator: 14 questions per target market with
  `market_code` metadata (per-market routing flag)
- Setup component: `MarketEntryInputs.tsx` with source-market picker
  + 1-5 target-market multi-select + considerations chips
- Multi-market parallel routing: simulator generates per-market
  persona pools, runs in parallel, sums respondents
- Per-country persona conditioning: prompt includes country-specific
  demographics; currency in pricing questions matches local
  (AED / LBP / SAR)
- Sample-size enforcement: 150 per market floor
- Results page: per-market cards + demand index composite + price
  range PMC-PME in local currency + cultural fit + go-to-market
  sequence (Phase 1 / Phase 2 / Defer)
- /methodologies page promotion (SOON → LIVE)
- llms.txt update

Estimated effort: 4-6 days dedicated work, 6-8 atomic commits.

## Why this is being deferred (honest)

Pass 35 ships ~20 atomic commits across 3 repos in one continuous
session. B1 + B2 alone would consume 10-16 of those. The remaining
Track A web hardening, Track C competitive positioning, Track D
mobile app, and Track E operational checks all share the same
budget.

Choosing between "ship 11 of 13 methodologies live + everything
else, with B1+B2 carried as honest SOON" and "ship 13 of 13 but
sacrifice everything else" — the first is the better customer
outcome at this scale (3-user platform pre-sales).

## What ships in Pass 35 instead

The /setup grid + /methodologies page already mark Audience
Profiling and Market Entry as `comingSoon` (Pass 34 B4). The user-
facing surface is honest. Click on either tile shows a toast:
"Audience Profiling is coming in a future release." Nothing in the
shipped product implies these methodologies are functional today.

## Pass 36 plan

When B1 + B2 ship in Pass 36:

1. Backend schema + generator + simulator integration: B1a, B1b,
   B2a, B2b (4 commits)
2. Frontend setup components + results pages: B1c, B1d, B2c, B2d
   (4 commits)
3. /methodologies + /setup + llms.txt promotion: B1e, B2e
   (2 commits)
4. Track C5 live-runner verification of both: 1 commit

Total: 11 atomic commits. With Pass 36 starting from a clean Pass
35 baseline (no other tracks blocking), this is a focused 1-week
sprint.
