# Pass 34 B5 — Untested Methodology Generator Audit

**Date:** 2026-05-08
**Scope:** Audit the 6 methodology question generators that have
**zero** paid production runs. Confirm the prompt + validator
produce a methodology-correct question battery before the Track C5
runner fires real Anthropic calls against them.

## Coverage matrix

| Goal type | Spec Q count | Validator | Brand substitution | Prompt forwards brand_name | Risk |
|---|---|---|---|---|---|
| `validate` (Concept Test) | 5 | yes | n/a (single concept) | yes via `clarify.brand_name` | LOW (gold-standard, 8 prod runs) |
| `compare` (Sequential Monadic) | dynamic ≥10 | yes (`validateCompareSurvey`) | per-concept text substituted | yes | MEDIUM (untested) |
| `marketing` (Ad Effectiveness) | 12-13 | yes | optional brand mention | yes | MEDIUM (1 prod run) |
| `pricing` (VW + GG) | 13 exactly | yes | per-product description | yes | MEDIUM (untested) |
| `roadmap` (MaxDiff + Kano) | dynamic | yes | n/a (feature-list driven) | yes | MEDIUM (untested) |
| `satisfaction` (NPS+CSAT+CES) | 10 exactly | yes (10-Q ordering check) | uses `<brand>` placeholder | **NO — relies on brief extraction** | MEDIUM (untested) |
| `brand_lift` | 10-14 funnel | yes | required + substituted (Pass 34 B2) | yes (Pass 34 B2) | LOW (B2 hardened) |
| `competitor` (Brand Health) | 11 exactly | yes | per-brand list | yes | MEDIUM (untested) |
| `naming_messaging` | 1 + N×(M+1) + 2 + ⌈N/2⌉ + (TURF? 1 : 0) | yes | per-candidate text (Pass 34 B1) | yes (Pass 34 B1) | LOW (B1 hardened) |
| `churn_research` | 11 exactly | yes | uses `<brand>` placeholder | yes | MEDIUM (untested) |

## Spec gaps flagged for Track C5 runner verification

### `satisfaction` — brand_name not forwarded to prompt
`buildCSATUserPrompt` does not pass `clarify.brand_name` to the user
prompt. The system prompt instructs Claude to "extract the SHORT
brand name from the brief." If the user populated brand_name via
UniversalMissionInputs but the brief itself is generic, Claude may
substitute a guessed brand into the 10 funnel questions.

**C5 expected behavior:** generate a CSAT survey with
`brand_name = "VETT Test"`, brief = "post-purchase touchpoint study",
and assert the 10 generated questions reference "VETT Test"
verbatim — not a guessed alternative.

### `churn_research` — same `<brand>` placeholder pattern
Same prompt structure as CSAT. System prompt (line 1645) says
`"<brand>" placeholders pull from clarify.brand_name. If absent, use
"the brand"`. So if brand_name is missing the model emits "the
brand" — better than the brand_lift "this concept" failure but still
less personalized than ideal.

**C5 expected behavior:** assert `<brand>` substitution worked when
`clarify.brand_name` was provided.

### `compare` — concept text substitution
The compare generator emits one screener + per-concept evaluation Qs
+ 1 forced choice + 1 paired comparison. The validator confirms
counts; the substitution happens via `clarify.concepts` JSON.

**C5 expected behavior:** generate a compare survey with two named
concepts ("MealMate Pro" and "Plate Plan") and assert each name
appears verbatim in evaluation questions.

### `competitor` — multi-brand funnel
Generates 11 questions with brand-health funnel stages (awareness /
consideration / preference / NPS) per brand from `competitor_brands`
+ attribute battery. Validator confirms ordering + counts.

**C5 expected behavior:** generate a competitor survey with 4
competitor brands and assert each brand name appears in the funnel
question text (not "Competitor 1", "Competitor 2").

### `pricing` (VW + GG) — product description substitution
13-question battery with 4 VW + 5 GG anchors. The system prompt
already enforces "use the short productName, never paste the full
brief" — this is the correct guard.

**C5 expected behavior:** generate a pricing survey for "Aurora
Coffee Co subscription" and assert all VW + GG questions reference
the product name.

### `roadmap` — feature substitution
MaxDiff requires a list of 8-12 features. If `roadmap_features` is
empty the generator could emit "Feature A / B / C" placeholders
(same failure mode as B1 naming). The validator counts MaxDiff
trials but does NOT check feature names appear verbatim.

**C5 expected behavior:** generate a roadmap survey with 8 named
features ("Voice control", "Dark mode", etc.) and assert each appears
in MaxDiff trial sets verbatim.

## Recommendation

Track C5 runner script (next commit) covers all 11 methodologies
with a `respondent_count = sample_size_minimum` mission, asserts
each generator's question count + brand/concept name substitution,
and produces a markdown report. Defer code-level fixes to whichever
methodology fails the runner audit; this audit gives the runner
explicit per-methodology assertion targets.
