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

- 5 respondents, 1 market, 8 channels:
  base = $35 + market = $0 + channel = $0 = **$35**
- 10 respondents, 3 markets, 15 channels:
  base = $35 + market = $10 + channel = $10 = **$55**
- 50 respondents, 8 markets, 60 channels:
  base = $99 + market = $50 + channel = $35 = **$184**
- 250 respondents, 16 markets, 120 channels:
  base = $299 + market = $100 + channel = $50 = **$449**

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
