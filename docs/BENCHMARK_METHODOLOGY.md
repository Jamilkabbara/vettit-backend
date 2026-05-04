# Brand Lift Benchmark Methodology

**Last updated:** 2026-05-04 (Pass 25 Phase 1F)

## What it is

Brand lift benchmarks (aided awareness norms, ad recall norms, NPS
norms, etc.) are **AI-estimated** by Claude Sonnet, not measured from
panel data. Each estimate is keyed by `(industry, region_key,
channel_mix_hash, audience_segment, kpi_template)` and cached for 30
days in the `brand_lift_benchmarks` table.

## Why AI estimates

VETT does not run a panel. Real benchmarks would require either:
1. A subscription to a third-party benchmark provider (rejected as
   too expensive for v1 + creates a competitor dependency).
2. Running enough VETT brand-lift missions in a category to derive
   internal norms (will become viable once mission volume grows).

Until that volume exists, AI estimates anchored on the model's
training-data knowledge of the category are the most honest
directional signal we can offer. The `BenchmarkBadge` UI tooltip
discloses "AI-estimated" + confidence level on every benchmark.

## Disclaimer (mandatory, on every brand-lift surface)

> Benchmarks are AI-estimated based on category norms. They are
> directional, not validated panel data. Use for orientation, not
> absolute claims.

This text appears on:
- BrandLiftResultsPage footer (`src/pages/BrandLiftResultsPage.tsx`)
- PDF report methodology page (`brand_lift_study.hbs`)
- Future PPTX methodology slide
- BenchmarkBadge tooltip per-KPI

## Service contract

`src/services/brandLiftBenchmarks.js`:

```js
async function getBenchmarks({
  industry,            // string
  region,              // { countries: [], cities: [] }
  channels,            // string[] of channels_master ids
  audience,            // optional segment label
  kpi_template,        // funnel_overview | brand_awareness_builder | ...
  missionId,           // optional
  userId,              // optional
})
// returns { benchmarks, source, confidence, cached }
```

Endpoint: `GET /api/results/:missionId/brand-lift-benchmarks`

## Cache lifecycle

- **Lookup key:** `(industry, region_key, channel_mix_hash,
  audience_segment, kpi_template)`.
- `region_key` = JSON-stringified sorted countries + cities.
- `channel_mix_hash` = SHA-1 of sorted channel ids, first 16 hex chars.
- **Hit + not expired:** return cached row, `cached: true`.
- **Hit but expired (`expires_at` < now):** fall through to AI call.
- **Miss:** call Claude, validate, insert with `expires_at = now() + 30 days`.

## Confidence levels

The system prompt explicitly instructs Claude to return:
- `high` — has grounded knowledge of this niche / region / channel mix
- `medium` — knows the category broadly but not this specific combo
- `low` — guessing; values are middle-of-range, not invented precision

`low` confidence is preferred over inventing tight numbers. The
BenchmarkBadge tooltip surfaces the confidence on every KPI.

## Validation

After every AI call, the service validates:
- `kpis` object present
- All percentage values in `[0, 100]`
- NPS in `[-100, 100]`
- `confidence` ∈ `{high, medium, low}`

Invalid responses throw before being cached, so bad data never
poisons the cache.

## Future work

- When VETT has run >100 brand_lift missions in a category, swap that
  category's entries from `source: 'ai_estimate'` to
  `source: 'vett_internal_panel'` and recalibrate.
- Add a public-API endpoint exposing the table for partners.
