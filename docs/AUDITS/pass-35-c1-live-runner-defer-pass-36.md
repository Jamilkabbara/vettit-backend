# Pass 35 C1+C2 — Live methodology runner: deferred to Pass 36

**Date:** 2026-05-08
**Reason:** Stripe checkout + 30-min poll loops + per-methodology
insights JSONB assertions need standalone infra work; honest
deferral instead of half-built runner.

## What ships in Pass 34/35 (already)

`scripts/test-all-methodologies.js` ships dry-run validation:

- All 11 fixtures pass shape validation per their generator contracts
- Pass 35 B3 + B4 add brand_name guard fixtures (CSAT + Churn)
- Cost guardrail enforced via `--run-all` flag (currently exits with
  Pass 35 deferral message instead of running)

## What Pass 36 C1 needs

The full live runner per the original Pass 35 C1 spec:

1. Stripe test-card checkout flow:
   - POST `/api/stripe/create-intent` with VETT100 promo (drops total to $0)
   - OR Stripe test card 4242 4242 4242 4242 with full charge
   - Capture `mission_id` from the create response
2. Question generation:
   - POST `/api/missions/:id/generate-questions`
   - Verify question count + brand/concept name substitution
3. Mission completion polling:
   - Poll `/api/missions/:id` every 30 seconds
   - Timeout cap: 30 minutes per mission
   - Detect status='completed' or status='failed'
4. Per-methodology insights JSONB assertions:
   - validate: `kpis`, `executive_summary`, `recommendations`
   - pricing: `vw_curves`, `pmc`, `pme`, `optimal_price`
   - roadmap: `feature_priority_ranking`, `maxdiff_utilities`
   - brand_lift: `awareness_lift`, `consideration_lift`, `nps`
   - csat: `nps_score`, `csat_score`, `ces_score`, `driver_tree`
   - competitor: `brand_health_funnel_per_brand`, `attribute_battery`
   - naming_messaging: `composite_score`, `win_rate`, `paired_win_rate`
   - churn_research: `top_reasons`, `tenure_at_churn`, `winback_potential`
   - audience_profiling (Pass 36): `segments`, `persona_descriptions`
   - market_entry (Pass 36): `per_market_demand_index`, `vw_curves_per_market`
5. Cost estimate banner before each run:
   - Display per-methodology cost prediction (sum to ~$5-15 total)
   - 10-second abort window before kicking off
6. Markdown report at `scripts/test-results/methodology-live-{date}.md`

## Why deferred

The Stripe test-card flow + 30-min completion poll + insights
JSONB shape assertions across 11 methodologies is a 2-3 day
focused build. Pass 35 has 25-30 commits across 3 repos in one
session window; the live runner alone can't fit.

## Pass 36 plan

3-5 commits in the live-runner sweep:
- C1a: Stripe test-card checkout helper in the runner
- C1b: Polling loop with timeout + cost guardrails
- C1c: Per-methodology insights JSONB assertions (11 methodologies)
- C1d: Cost-estimate dry-run banner + 10s abort
- C2: First full-suite execution + report committed

## What this costs to operate

Each full live run costs ~$5-15 in Anthropic API spend depending
on how many missions complete and how much chat / synthesis runs.
Stripe test-card transactions are free (Stripe doesn't charge for
test mode). The runner script enforces the cost ceiling via
explicit `--run-all=live` flag plus the abort window.
