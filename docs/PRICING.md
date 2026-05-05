# Pricing (Pass 27)

**Last updated:** 2026-05-05

Backend is canonical: `POST /api/missions` recomputes server-side at
payment time and persists the breakdown in `missions.price_breakdown`.

## Respondent ladders (per goal type)

See `src/utils/pricingEngine.js` for `VOLUME_TIERS`,
`BRAND_LIFT_TIERS`, `CREATIVE_ATTENTION_TIERS`. CA min = 10
respondents; brand_lift uses the volume ladder for base price.

## Pass 27 — Brand Lift uplift tiers

**Market uplift:**

| Markets | Tier | Uplift |
|---|---|---|
| 1 | single_market | $0 |
| 2-3 | small_multi | +$10 |
| 4-7 | regional | +$25 |
| 8-15 | multi_regional | +$50 |
| 16+ | global | +$100 |

**Channel uplift:**

| Channels | Tier | Uplift |
|---|---|---|
| 1-10 | starter | $0 |
| 11-25 | standard | +$10 |
| 26-50 | plus | +$20 |
| 51-100 | pro | +$35 |
| 101+ | enterprise | +$50 |

## Worked examples

| Respondents | Markets | Channels | Base | Market uplift | Channel uplift | **Total** |
|---|---|---|---|---|---|---|
| 5 (Sniff Test) | 1 | 8 | $9 | $0 | $0 | **$9** |
| 50 (Validate) | 1 | 12 | $99 | $0 | $10 | **$109** |
| 100 (Validate) | 3 | 25 | $179 | $10 | $10 | **$199** |
| 250 (Validate) | 8 | 60 | $299 | $50 | $20 | **$369** |
| 1000 (Pro) | 16 | 120 | $799 | $100 | $50 | **$949** |
| 5000 (Enterprise) | 16+ | 101+ | $1990 | $100 | $50 | **$2140** |

Bands stack additively: lift the respondent base off the volume ladder,
then add the market uplift band, then add the channel uplift band. The
backend applies the same composition in `pricingEngine.js`.

## Validation

- `creative_attention` with `respondent_count < 10` → 400 + `min_respondents`
- `brand_lift` with no `targetedMarkets` → 400 + `markets_required`
- `brand_lift` with no `campaignChannels` → 400 + `channels_required`
- Frontend total drift > $0.50 from server total → log warning, use server.

## Persisted

`missions.price_breakdown` (JSONB) =
`{ base_usd, market_uplift_usd, channel_uplift_usd, total_usd,
   market_count, channel_count, ladder_version: 'pass_27_v1' }`.

Bumping `ladder_version` lets future passes re-price retroactively
without re-running missions.
