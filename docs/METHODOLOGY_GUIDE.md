# Methodology Guide

**Last updated:** 2026-05-07 (Pass 30 C4)

VETT ships industry-standard research methodologies on synthetic
respondents. Each methodology has a setup-page input collector, a
backend question generator, a results-page visualization, and a sample
size minimum the setup page surfaces inline.

This file is the index. Each methodology links to the audit row in
[MISSION_METHODOLOGY_AUDIT.md](./MISSION_METHODOLOGY_AUDIT.md) and to the
relevant code paths.

## Shipped methodologies (Pass 30 + earlier)

| Methodology | Mission `goal_type` | Sample size (min / best) | Setup component | Backend dispatch | Results page | Pass |
|---|---|---|---|---|---|---|
| Brand Lift Study with Incrementality | `brand_lift` | 100 / 250 | `BrandLiftSetupSection.tsx` | `generateBrandLiftSurvey` | `BrandLiftResultsPage.tsx` | 25→28 |
| Frame-by-Frame Creative Attention | `creative_attention` | 10 / 50 | `/creative-attention/new` flow | `creativeAttention.js` (CA pipeline) | `CreativeAttentionResultsPage.tsx` | 25–26 |
| Van Westendorp + Gabor-Granger | `pricing` | 150 / 300 | `PricingInputs.tsx` | `generatePricingSurvey` | `PricingResultsPage.tsx` | 29 B4–B5 |
| MaxDiff + Kano | `roadmap` | 150 / 250 | `FeatureListCollector.tsx` | `generateRoadmapSurvey` | `RoadmapResultsPage.tsx` | 29 B6–B7 |
| NPS + CSAT + CES | `satisfaction` | 100 / 200 | `CSATInputs.tsx` | `generateCSATSurvey` | `CSATResultsPage.tsx` | 29 B8–B9 |
| Concept Test | `validate` | 100 / 200 | `ConceptCollector.tsx` | `generateValidateSurvey` | `ValidateResultsPage.tsx` | 30 B1–B2 |
| Sequential Monadic | `compare` | 80 / 150 (per concept) | `ConceptListCollector.tsx` | `generateCompareSurvey` | `CompareResultsPage.tsx` | 30 B3–B4 |
| Ad Effectiveness | `marketing` | 100 / 200 | `AdTestingInputs.tsx` | `generateMarketingSurvey` | _(generic ResultsPage — bespoke deferred to Pass 31)_ | 30 B5 |

Cross-cutting components ship in Pass 29 B2–B3:

| Component | Path | Purpose |
|---|---|---|
| `UniversalMissionInputs` | `vett-platform src/components/setup/UniversalMissionInputs.tsx` | Brand / category / audience / competitors — required on every methodology-bound type |
| `SampleSizeGuidance` | `vett-platform src/components/setup/SampleSizeGuidance.tsx` | Below-min / adequate / strong caption per methodology |
| `sampleSizeMinimums` | `vett-platform src/lib/sampleSizeMinimums.ts` | Single source of truth for the 16 method floor / best targets |

## Per-methodology references

### Brand Lift Study with Incrementality

Funnel-staged 10–14 questions covering screening → ad recall (unaided
+ aided) → brand awareness (unaided + aided) → familiarity →
favorability → consideration → purchase intent → NPS → message
association → channel-specific recall. Paired exposed / control
arms when the user picks the lift mode in the setup flow.

- See: [BRAND_LIFT_STUDY_V3.md](./BRAND_LIFT_STUDY_V3.md)
- Filter wire-up + lift-mode aggregator: [INCREMENTALITY.md](./INCREMENTALITY.md)
- Channel + market taxonomies: [CHANNELS_MASTER_LIST.md](./CHANNELS_MASTER_LIST.md), [MARKETS_DIRECTORY.md](./MARKETS_DIRECTORY.md)

### Frame-by-Frame Creative Attention

24-emotion taxonomy (8 Plutchik basic + 16 nuanced research-derived),
attention scoring per frame, cross-channel benchmarks, AI-generated
strengths / weaknesses / recommendations. Setup flow lives at
`/creative-attention/new` (separate from the generic `MissionSetupPage`).

- Setup spec: vett-platform `src/pages/CreativeAttentionPage.tsx`
- CA exports: PDF (Pass 27 H), XLSX (Pass 27.5 B)
- Audit: [PASS_27_CA_EXPORT_AUDIT.md](./PASS_27_CA_EXPORT_AUDIT.md)

### Van Westendorp + Gabor-Granger (Pricing)

13-question instrument: screener, current behavior, 4 Van Westendorp
questions (too expensive / expensive but consider / bargain / too
cheap), 5 Gabor-Granger price-acceptance anchors on an ascending
ladder, WTP ceiling, switching cost. Currency configurable per
mission (8 ISO codes supported in the picker; backend accepts any).

Results page renders the 4-curve VW plot with the 4 standard
intersection points (PMC, PME, IPP, OPP) plus the GG demand curve
with the revenue-maximizing price highlighted. Industry callouts:
acceptable range typically 30–50% of OPP; revenue-max often 10–20%
below OPP.

Sample size: GG bound is the binding constraint at min 150 / best 300.

### MaxDiff + Kano (Feature Roadmap)

12 MaxDiff sets (4 features per set, balanced so each feature appears
in 2–5 sets) + 2 Kano questions (functional / dysfunctional pair) for
the top 5 features → 23 total Qs when feature_count ≥ 5.

Utility computed on the frontend as `(best - worst) / (best + worst)`
normalized 0–100 across the feature set. 95% confidence intervals
from binomial stderr on the best/worst ratio. Kano classification
uses the standard Lee & Newcomb modal-pair simplification — 6
categories (Must-Have / Performance / Delighter / Indifferent /
Reverse / Questionable).

Results page combines MaxDiff utility ranks with Kano categories into
a build-recommendation table.

### NPS + CSAT + CES (Customer Satisfaction)

10-question battery: screener, NPS (0–10), NPS driver (text), CSAT
(5-pt single), CSAT driver (text), CES (7-pt rating), CES driver
(text), attribute matrix (Quality / Value / Reliability / Service /
Ease of use), retention intent (1–5), specific issues (multi-select
generated from the brief).

Results page shows scores against industry benchmark bands:

| Metric | Excellent | Great | Good | Fair | Poor / Crisis |
|---|---|---|---|---|---|
| NPS | ≥70 | 50–69 | 30–49 | 0–29 | < 0 (Crisis < -10) |
| CSAT (top-2-box %) | ≥90 | 80–89 | 70–79 | 60–69 | <60 |
| CES (top-2-box % on 6+7 of 7) | ≥85 | 75–84 | 65–74 | 55–64 | <55 |

Touchpoint, customer type, and recency window are configurable per
mission. The screener qualification phrasing pulls the recency window
verbatim ("past 30 days", "past 90 days", "past 12 months", "all time").

## General Research stays open-ended

The `research` mission type has no methodology lock. Universal inputs
are optional. The default 5-question generic prompt remains. This is
intentional — one mission type is reserved for studies that don't fit
a named methodology, so the platform doesn't lock users into a wrong-fit
template.

## Pass 30 closure plan

Eight mission types are still on the generic 5-question prompt and
deferred to Pass 30:

| `goal_type` | Methodology | Sample size (min / best) |
|---|---|---|
| `validate` | Concept Test | 100 / 200 |
| `compare` | Sequential Monadic | 80 / 150 (per concept) |
| `marketing` | Ad Effectiveness | 100 / 200 |
| `competitor` | Brand Health Tracker | 200 / 400 |
| `audience_profiling` | Segmentation | 300 / 500 |
| `naming_messaging` | Monadic + Paired + TURF | 80 / 150 (per candidate) |
| `market_entry` | Combined Market Entry | 100 / 200 (per market) |
| `churn_research` | Driver Tree + Win-Back | 100 / 200 |

The Pass 30 plan in
[MISSION_METHODOLOGY_AUDIT.md](./MISSION_METHODOLOGY_AUDIT.md)
spells out 16 sub-phases (one input-collector + backend commit and
one results-page commit per type) using the same template Pass 29
established for Pricing / Roadmap / CSAT.

Each Pass 30 sub-phase will land alongside an entry on the
`/methodologies` marketing page (deferred from Pass 29 C2/C3) and
optionally a `/vs/<competitor>` comparison page. The `methodologies`
page itself is the consolidation point — once all 11 methodologies
are shipped, that page becomes the canonical "what VETT runs"
reference for prospects.

## Honest claims

VETT's methodology rigor is the honest competitive claim. We run the
Van Westendorp questions in the canonical script, score NPS using
the standard promoter / detractor split, classify Kano using the
published matrix, and compute MaxDiff utility from best-worst counts
the same way Sawtooth and Conjointly do.

What we do NOT claim:
- Peer-reviewed methodology validation (we have not commissioned one)
- ISO certification (none)
- 100% accuracy or "as good as" real-customer panels (synthetic
  respondents are calibrated to demographic patterns from real
  population data; insights are directionally indicative)

For high-stakes decisions, the audit doc and the in-app benchmark
callouts on every results page point users to validate critical
findings against real-customer panels where the cost is justified.
