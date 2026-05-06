# Mission Methodology Audit

**Last updated:** 2026-05-06 (Pass 29 B1)

A read-only inventory of where each of the 14 canonical mission types
sits on the methodology-rigor scale. Each section follows the same
template: pre-Pass-29 state, industry-standard methodology, required
inputs, question structure, results output, sample-size guidance, and
the Pass 29 sub-phase that closes the gap (or `Already best-in-class`
for types shipped in earlier passes).

The 14 ids match `src/data/missionGoals.ts` and the
`missions.goal_type` column.

| # | id (`missions.goal_type`) | Label | Pass 29 status |
|---|---|---|---|
| 1 | `validate` | Validate Product | ⏸ Deferred to Pass 30 |
| 2 | `compare` | Compare Concepts | ⏸ Deferred to Pass 30 |
| 3 | `marketing` | Test Marketing / Ads | ⏸ Deferred to Pass 30 |
| 4 | `satisfaction` | Customer Satisfaction | ✅ B8 + B9 ship NPS+CSAT+CES |
| 5 | `pricing` | Pricing Research | ✅ B4 + B5 ship VW + GG |
| 6 | `roadmap` | Feature Roadmap | ✅ B6 + B7 ship MaxDiff + Kano |
| 7 | `research` | General Research | Stays open-ended (no methodology lock) |
| 8 | `competitor` | Competitor Analysis | ⏸ Deferred to Pass 30 |
| 9 | `audience_profiling` | Audience Profiling | ⏸ Deferred to Pass 30 |
| 10 | `naming_messaging` | Naming & Messaging | ⏸ Deferred to Pass 30 |
| 11 | `market_entry` | Market Entry | ⏸ Deferred to Pass 30 |
| 12 | `churn_research` | Churn Research | ⏸ Deferred to Pass 30 |
| 13 | `brand_lift` | Brand Lift Study | ✅ Already best-in-class (Pass 28 B) |
| 14 | `creative_attention` | Creative Attention | ✅ Already best-in-class (Pass 25–26) |

Pass 29 ships methodology-correct flows for 3 of the 11 outstanding
mission types (Pricing, Feature Roadmap, Customer Satisfaction). The
remaining 8 land in Pass 30 against the same template.

---

## 1. `validate` — Validate Product

**Pre-Pass-29 state.** Generic 5-question survey from the default
`survey_gen` prompt. No concept upload, no price-point input, no
purchase-intent calibration.

**Industry-standard methodology.** Concept Test — single-concept
appeal + relevance + uniqueness + believability + purchase intent
battery, with open-ended diagnostics for "what's the biggest concern"
and "who is this for".

**Required user inputs.** Brand, category, concept description
(≥50 chars), optional concept image/video, optional price point.

**Question structure.** 8–9 questions: screener, reaction (1–10),
relevance (1–7), uniqueness (1–7), believability (1–7), purchase
intent (1–5), word cloud (open), biggest concern (open), who would
buy (open).

**Results page output.** Top-2-box appeal + intent, attribute radar,
verbatim themes, recommendation status (launch-ready / iterate / kill).

**Industry benchmarks.** Top-2-box appeal ≥40% = strong; top-2-box
intent ≥60% = launch-ready; ≥50% relevance + ≥40% uniqueness =
differentiated.

**Sample size.** Min 100, best 200.

**Pass 29 commit.** ⏸ Deferred to Pass 30.

---

## 2. `compare` — Compare Concepts

**Pre-Pass-29 state.** Generic 5-question survey. No concept list
collector, no rotated monadic exposure.

**Industry-standard methodology.** Sequential Monadic — each respondent
sees N concepts in randomized order, evaluates each on the same battery
as Concept Test, then makes a forced choice with reason.

**Required user inputs.** 2–5 concepts, each with name + description
(≥30 chars) + optional image/video + optional price.

**Question structure.** Per-concept battery (5 Qs) × N concepts +
2 final (forced choice + reason). 12–27 Qs total.

**Results page output.** Per-concept score table, head-to-head matrix,
forced-choice winner, reason themes.

**Industry benchmarks.** Winner separation of ≥10pp on top-2-box appeal
= clear preference; <5pp = statistical tie.

**Sample size.** Min 80 per concept, best 150 per concept.

**Pass 29 commit.** ⏸ Deferred to Pass 30.

---

## 3. `marketing` — Test Marketing / Ads

**Pre-Pass-29 state.** Generic 5-question survey. No creative
upload, no channel context, no recall-attribution-persuasion structure.

**Industry-standard methodology.** Ad Effectiveness (Kantar Link / ASI
tradition) — recall, brand attribution, message takeaway, likeability,
stopping power, distinctiveness, emotional response, persuasion.

**Required user inputs.** Creative (image/video), brand name, channel
(tv/social/ooh/digital_video/audio), format (length or type),
campaign objective (awareness/consideration/purchase/loyalty).

**Question structure.** 11–12 questions: screener, unaided recall,
exposure, aided recall, brand attribution, main message, likeability,
stopping power, distinctiveness, emotional response, persuasion,
intended-message match.

**Results page output.** Branded recall %, top-2-box likeability,
persuasion shift, emotion radar, channel-fit score.

**Industry benchmarks.** Branded recall ≥40% = strong; top-2-box
likeability ≥50% = positive; persuasion shift +0.5pt on 7-pt = real.

**Sample size.** Min 100, best 200+.

**Pass 29 commit.** ⏸ Deferred to Pass 30.

---

## 4. `satisfaction` — Customer Satisfaction

**Pre-Pass-29 state.** Generic 5-question survey. No touchpoint
selector, no NPS/CSAT/CES dispatch, no benchmark band callouts.

**Industry-standard methodology.** NPS (recommendation) + CSAT
(satisfaction) + CES (effort) triple — each with a driver follow-up
plus an attribute matrix and retention-intent question.

**Required user inputs.** Touchpoint
(product/support/purchase/onboarding/overall/custom), customer type
(all/new/returning/churned), recency window
(30d/90d/12m/all-time).

**Question structure.** 10 questions: screener, NPS, NPS driver,
CSAT, CSAT driver, CES, CES driver, attribute matrix, retention intent,
specific issues.

**Results page output.** NPS / CSAT / CES scores with industry
benchmark bands, driver themes, attribute heatmap, retention forecast.

**Industry benchmarks.** NPS bands: ≥70 excellent / 50–69 great /
30–49 good / 0–29 fair / <0 poor; CSAT top-2-box ≥80% = great; CES
top-2-box ≥75% = great.

**Sample size.** Min 100, best 200+.

**Pass 29 commit.** ✅ Shipped in Pass 29 B8 + B9 (`CSATInputs.tsx`,
`generateCSATSurvey`, `CSATResultsPage.tsx`).

---

## 5. `pricing` — Pricing Research

**Pre-Pass-29 state.** Generic 5-question survey. No Van Westendorp
4-question battery, no Gabor-Granger price ladder, no currency input,
no demand-curve viz.

**Industry-standard methodology.** Van Westendorp (4 cumulative price
sensitivity questions: too expensive / expensive but consider /
bargain / too cheap) plus Gabor-Granger (5 anchored prices on a
ladder for revenue-maximizing curve).

**Required user inputs.** Product description (≥50 chars), currency
(USD/AED/EUR/GBP/SAR/etc), pricing model
(one-time/monthly/annual/usage), pricing context (free text),
optional expected price range.

**Question structure.** 13 questions: screener, current behavior,
VW × 4, GG × 5, WTP ceiling, switching cost.

**Results page output.** Optimal Price Point (OPP), Acceptable Price
Range (PMC–PME), Indifference Price Point (IPP),
Revenue-Maximizing Price (from GG), price elasticity, 4-curve VW
plot, GG demand + revenue chart.

**Industry benchmarks.** Acceptable range typically spans 30–50% of
OPP; revenue-max often 10–20% below OPP.

**Sample size.** Min 150 (GG bound), best 300+.

**Pass 29 commit.** ✅ Shipped in Pass 29 B4 + B5 (`PricingInputs.tsx`,
`generatePricingSurvey`, `PricingResultsPage.tsx`).

---

## 6. `roadmap` — Feature Roadmap

**Pre-Pass-29 state.** Generic 5-question survey. No feature list
collector, no MaxDiff trade-off sets, no Kano classification.

**Industry-standard methodology.** MaxDiff (best-worst scaling on
sets of 4 features × ~12 sets) plus Kano (functional / dysfunctional
pair per top feature classifies as Must-Have / Performance / Delighter
/ Indifferent / Reverse / Questionable).

**Required user inputs.** 6–30 features, each with name + optional
description.

**Question structure.** ~12 MaxDiff sets (best/worst per set) plus
2 Kano questions per top-5+ feature.

**Results page output.** Utility score per feature with 95% CI, Kano
2D quadrant scatter, combined "build first" recommendation table.

**Industry benchmarks.** Utility >15 = strongly preferred; >25 = clear
winner; <5 = noise. Must-Haves can have low utility but presence is
mandatory.

**Sample size.** MaxDiff min 150, best 250; Kano min 100, best 200.

**Pass 29 commit.** ✅ Shipped in Pass 29 B6 + B7
(`FeatureListCollector.tsx`, `generateRoadmapSurvey`,
`RoadmapResultsPage.tsx`).

---

## 7. `research` — General Research

**Pre-Pass-29 state.** Generic 5-question survey from the default
`survey_gen` prompt. Open-ended Q types adapt to the brief.

**Industry-standard methodology.** None — this goal exists precisely
to support open-ended studies that don't fit a named methodology.

**Required user inputs.** Brief only. Universal inputs (brand,
category, audience, competitors) are all optional.

**Question structure.** 5 questions tailored to the brief.

**Results page output.** Generic ResultsPage with per-question
distribution + AI insights.

**Industry benchmarks.** N/A.

**Sample size.** Min 50 directional, best 200+ for sub-segment splits.

**Pass 29 commit.** No change. General Research stays open-ended by
design — locking it to a methodology would defeat the purpose.

---

## 8. `competitor` — Competitor Analysis

**Pre-Pass-29 state.** Generic 5-question survey. No brand list
input, no attribute battery, no funnel-by-brand structure.

**Industry-standard methodology.** Brand Health Tracker
(Kantar/YouGov standard) — awareness → consideration → use →
recommendation funnel per brand, plus attribute matrix and switching
intent.

**Required user inputs.** Focal brand (from UniversalMissionInputs),
≥3 ≤8 competitors, attribute battery (default 10 attributes,
deselectable + custom-extensible).

**Question structure.** 9 questions: screener, unaided awareness, aided
awareness, consideration, current use, NPS by brand, attribute matrix,
switching intent, switching target.

**Results page output.** Per-brand funnel chart, attribute heatmap,
switching matrix, share of voice, NPS by brand with benchmark band.

**Industry benchmarks.** Aided awareness >80% = strong;
consideration >50% of aware = healthy mid-funnel; use >50% of
considered = strong loyalty.

**Sample size.** Min 200, best 400+.

**Pass 29 commit.** ⏸ Deferred to Pass 30.

---

## 9. `audience_profiling` — Audience Profiling

**Pre-Pass-29 state.** Generic 5-question survey. No segmentation
dimension picker, no cluster questions, no segment cards on the
results page.

**Industry-standard methodology.** Segmentation — attitudinal /
behavioral / needs / media-habit battery (15–20 Qs) + K-means
clustering on the response matrix at synthesis time.

**Required user inputs.** Product context, dimensions
(attitude/behavior/need/demographic/media), desired segment count
(3–7).

**Question structure.** 15–20 mixed questions across selected
dimensions.

**Results page output.** Per-segment cards (name, size, persona,
attributes, demographic skew), distinguishing-attribute radar,
overlap matrix, recommended targeting.

**Industry benchmarks.** Segments below 10% of population typically
unstable; need ≥3 distinguishing attributes per segment.

**Sample size.** Min 300 (clusters unstable below), best 500+.

**Pass 29 commit.** ⏸ Deferred to Pass 30.

---

## 10. `naming_messaging` — Naming & Messaging

**Pre-Pass-29 state.** Generic 5-question survey. No candidate list,
no monadic + paired structure, no TURF for taglines.

**Industry-standard methodology.** Monadic evaluation (rate each
candidate on 5 criteria) + Paired comparison (head-to-head wins) +
TURF for taglines (find the optimal SET that maximizes reach).

**Required user inputs.** Test type (names/taglines/both), 3–10
candidates, optional brand personality, evaluation criteria
(memorable/distinctive/relevant/positive/easy/modern, default top 5).

**Question structure.** Per-candidate battery (5–6 Qs) + paired
comparisons + TURF question for taglines.

**Results page output.** Winner card, per-candidate score table,
attribute heatmap, word-association cloud per candidate, TURF chart.

**Industry benchmarks.** Composite ≥5.5 = strong; ≥6.0 = winner;
paired win rate ≥60% = clear preference.

**Sample size.** Min 80 per candidate, best 150 per candidate.

**Pass 29 commit.** ⏸ Deferred to Pass 30.

---

## 11. `market_entry` — Market Entry

**Pre-Pass-29 state.** Generic 5-question survey. No source/target
markets, no per-market price elasticity, no cultural fit signal.

**Industry-standard methodology.** Combined Market Entry — demand
sizing (awareness × interest × intent) + Van Westendorp light per
market + competitive context + cultural fit + purchase barriers.

**Required user inputs.** Product description, source market,
target markets (multi-select), entry considerations
(demand_sizing/pricing/competition/cultural_fit/regulatory).

**Question structure.** 9 questions per target market.

**Results page output.** Per-market summary cards, demand comparison
chart, price elasticity per market, competitive landscape per market,
cultural fit heatmap, recommended go-to-market sequence.

**Industry benchmarks.** Composite demand index ≥60 = strong entry
candidate; <40 = defer or rethink positioning.

**Sample size.** Min 100 per target market, best 200+ per market.

**Pass 29 commit.** ⏸ Deferred to Pass 30.

---

## 12. `churn_research` — Churn Research

**Pre-Pass-29 state.** Generic 5-question survey. No churn
definition, no driver tree, no win-back triggers.

**Industry-standard methodology.** Churn Driver Tree + Win-Back
Potential — qualifies churned respondents, asks reason categories
+ detail, satisfaction at churn, NPS at churn, win-back probability,
win-back triggers, competitive switch, CES at exit, warning signs.

**Required user inputs.** Churn definition
(cancelled/inactive/custom + window), customer type
(subscription/one-time/recurring/B2B), product category, win-back
possible flag.

**Question structure.** 10 questions through the driver tree.

**Results page output.** Driver tree (root → reason → sub-reasons),
win-back stacked bar, win-back triggers heatmap, CES at exit,
warning-signs verbatim themes, recommendations.

**Industry benchmarks.** Win-back % varies by reason category — price
churn often >50% winnable; competitor switch <20%.

**Sample size.** Min 100, best 200+.

**Pass 29 commit.** ⏸ Deferred to Pass 30.

---

## 13. `brand_lift` — Brand Lift Study

**Pre-Pass-29 state.** ✅ Already best-in-class.

**Industry-standard methodology.** Brand Lift Study with
Incrementality (paired exposed/control). Funnel-staged questions:
screening → unaided ad recall → aided ad recall → unaided brand
awareness → aided brand awareness → familiarity → favorability →
consideration → purchase intent → NPS → message association →
channel-specific recall.

**Pass 29 commit.** No change. The full setup flow (markets,
channels, waves, competitors, KPI template) shipped in Pass 28 A;
the 10–14 funnel-staged question dispatch shipped in Pass 28 B; the
filter wire-up with paired exposed/control aggregations shipped in
Pass 28 C.

---

## 14. `creative_attention` — Creative Attention

**Pre-Pass-29 state.** ✅ Already best-in-class.

**Industry-standard methodology.** Frame-by-frame Creative Attention
analysis — 24-emotion taxonomy (8 Plutchik basic + 16 nuanced),
attention scoring per frame, cross-channel benchmarks, AI-generated
strengths/weaknesses/recommendations.

**Pass 29 commit.** No change. Setup, simulation, and reporting all
shipped Pass 25 → 26 → 27.5 (CA-specific PDF + XLSX templates).

---

## Pass 30 closure plan

For the 8 mission types deferred to Pass 30, each has the same
3-commit shape Pass 29 used for Pricing / Roadmap / CSAT:

1. Frontend input collector + backend question-gen branch (one
   commit per mission type).
2. Frontend results page (one commit per mission type that needs a
   methodology-specific viz; CSAT-style benchmark callouts can be
   folded into the input-collector commit when the page reuses the
   generic ResultsPage).
3. Frontend marketing-page entry under `/methodologies` (one commit
   batched with C1).

Pass 30 sub-phase plan (16 commits):

| # | Sub-phase | Mission |
|---|---|---|
| 1 | A — Validate Product (collector + concept test backend) | `validate` |
| 2 | A — Validate Product (results page) | `validate` |
| 3 | B — Compare Concepts (collector + sequential monadic) | `compare` |
| 4 | B — Compare Concepts (results page) | `compare` |
| 5 | C — Test Marketing (collector + ad effectiveness) | `marketing` |
| 6 | C — Test Marketing (results page) | `marketing` |
| 7 | D — Competitor Analysis (collector + brand health tracker) | `competitor` |
| 8 | D — Competitor Analysis (results page) | `competitor` |
| 9 | E — Audience Profiling (collector + segmentation) | `audience_profiling` |
| 10 | E — Audience Profiling (results page) | `audience_profiling` |
| 11 | F — Naming & Messaging (collector + monadic + paired + TURF) | `naming_messaging` |
| 12 | F — Naming & Messaging (results page) | `naming_messaging` |
| 13 | G — Market Entry (collector + combined methodology) | `market_entry` |
| 14 | G — Market Entry (results page) | `market_entry` |
| 15 | H — Churn Research (collector + driver tree) | `churn_research` |
| 16 | H — Churn Research (results page) | `churn_research` |
