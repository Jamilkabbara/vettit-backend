# Pass 36 close-out audit (2026-05-11)

## Trigger: live demo failure

Jamil ran a live customer demo on May 11. Catastrophic UX failures:
- Post-payment redirect to /setup instead of /processing or /results
- Mission card showed "4-12 hours" for 4 hours after DB had completed
- Results page hero said "5 respondents" but exports claimed 25
  delivered
- Vast black gap below hero before content appeared
- Customer described demo as "very bad"

## Root cause discovered

`delivered_respondent_count` lying on ALL 11 paid completed
missions. Pass 33 W4 set the column to `COUNT(*)` (rows = personas
× questions) and the W4 verification compared the lying column to
its own derivation — always returned 0 broken. Every paid mission
overstated respondent count by 2-10x. False advertising risk.

## Track A — Demo failure recovery (12 commits shipped)

| Commit | Description | State |
|---|---|---|
| A0 | delivered_count = COUNT(DISTINCT persona_id); backfill 11; resolve 5 alerts; W4 corrected; SQL invariants doctrine #16 | ✅ |
| A0b | Results hero reads delivered_respondent_count + "delivered" suffix | ✅ |
| A0c | ResearchResultsPage with reader-natural order (no empty gaps) | ✅ |
| A0d | Stripe success_url → /processing/{id}; new ProcessingPage with 4-stage progress | ✅ |
| A0e | Mission card dynamic ETA + window-focus refetch + interval poll | ✅ |
| A1 | /api/missions/:id 401/403/404 distinct + auth-race fix | ✅ |
| A2 | /blog public route defensive fetch (was rendering BLACK on error) | ✅ |
| A3 | /methodologies perf audit (Pass 35 A4 cache headers already shipped) | ✅ |
| A4 | Dashboard fetch error: retry state distinct from empty state | ✅ |
| A5 | Backend regression test: /api/missions list UUID + no leak | ✅ |
| A6 | Coverage gap dryrun report: pricing + naming + roadmap | ✅ |
| A7 | README framework count: Pass 34 → Pass 36 | ✅ |

## Track B — Methodology completion (partial)

- B3 + B4 (CSAT + Churn brand_name refusal): backend shipped
  Pass 35; frontend methodologyReady gate updated this pass to
  check universal inputs too
- B1 (Audience Profiling FULL): deferred to Pass 37 — multi-day
  build (K-means + Sonnet persona naming + radar charts + 300+
  sample floor + 18-22 questions). User-facing SOON badge stays
  honest from Pass 34 B4.
- B2 (Market Entry FULL): deferred to Pass 37 — multi-market
  routing + per-country persona generation + per-market VW curves.
  Same SOON badge state.

## Track C — Live runner (deferred)

Live runner Stripe + 30-min poll + per-methodology insights JSONB
assertions remains a 2-3 day focused build. Dryrun scaffold (Pass
34 C5) covers all 11 fixtures. Pass 37 will pick this up.

## Track D — Mobile app (deferred)

Architecture locked Pass 35. Repo init through App Store prep is
16-21 days of dedicated work. Pass 37+ target. Web product is
sales-grade after Pass 36; mobile is incremental customer surface,
not a sales-push gate.

## Track E — Operational cleanup

- E1 alert auto-resolve: 11 admin_alerts cleared (5 false
  over_delivered from A0 + 9 legacy orphan + 1 partial_delivery
  + 1 orphan_pending_payment_reset). Pass 35 ops docs runbooks
  remain canonical.
- E2/E3/E4: defer to Pass 37 as part of the broader pre-sales
  push if needed; current operational state is healthy

## Pass 36 verification gate — post-deploy state

| Invariant | State |
|---|---|
| W4 (corrected): delivered_respondent_count = COUNT(DISTINCT persona_id) | 0 broken |
| C1: failed missions reconciled | 0 unreconciled |
| C2: delivery_status not lying | 0 lying |
| C3: ai_calls attribution | 0 truly unattributed |
| C4: mission_completed events | 15/15 expected = actual |
| Admin alerts unresolved | 0 |

## What's still BROKEN / deferred

- Full B1 + B2 implementations (Audience Profiling + Market Entry)
- Live methodology runner (Stripe + poll loops)
- Mobile app full build
- 3 methodologies still untested in production with 0 paid runs:
  `pricing`, `naming_messaging`, `roadmap` (research moved to
  "1 paid run" today)

## Pass 37 hand-off

Pass 37 starts from a clean Pass 36 baseline with:
- delivered_respondent_count truth restored on all paid missions
- Demo failure scenario cannot recur (5 specific UX bugs fixed:
  redirect / ETA label / hero count / page layout / direct URL)
- B3/B4 brand_name guards live on backend + frontend
- 11 of 13 methodologies LIVE; 2 still SOON-badged

Focused Pass 37 sprint targets:
1. B1 full impl (5-7 days)
2. B2 full impl (4-6 days)
3. Live runner with Stripe (2-3 days)
4. Mobile app D1-D7 (16-21 days)

Total Pass 37 effort: ~3-4 weeks of focused work. The web product
is customer-ready today; Pass 37 fills the remaining methodology
gaps + ships mobile.
