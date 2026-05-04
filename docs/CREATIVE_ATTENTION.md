# Creative Attention — pricing tiers

**Last updated:** 2026-05-04 (Pass 25 Phase 0.3)

## Tier ladder

CA is a respondent-based ladder, not a flat per-asset charge. The
floor is **10 respondents** — anything less yields no statistical
signal. Per-respondent rate is slightly higher than the validate
ladder because each respondent runs frame-by-frame Claude Vision
analysis (more compute than text-only persona simulation).

| Tier | Respondents | Price | $/respondent |
|---|---|---|---|
| Sniff Test | 10 | $19 | $1.90 |
| Validate | 25 | $39 | $1.56 |
| Confidence | 50 | $69 | $1.38 |
| Deep Dive | 100 | $129 | $1.29 |
| Deep Dive XL | 250 | $299 | $1.20 |

## Backend enforcement

`POST /api/missions` rejects CA payloads with `respondent_count < 10`
and returns:

```
HTTP 400
{ "error": "min_respondents",
  "message": "Creative Attention requires at least 10 respondents." }
```

`resolveTier({ goalType: 'creative_attention', respondentCount })`
returns `null` for `respondentCount < 10` so callers know to fail.

## Source of truth

`src/utils/pricingEngine.js`:
- `CREATIVE_ATTENTION_TIERS` — the table above
- `CA_MIN_RESPONDENTS` = 10

Frontend mirror:
- `src/utils/pricingEngine.ts` — same table
- `src/components/creative-attention/CreativeAttentionTierSlider.tsx`
  renders the slider with snap points at each anchor count

## History

- Before Pass 25 Phase 0.3: flat per-asset table (Image $19 / Video
  $39 / Bundle 5 $79 / Series 20 $249), `respondent_count: 1`
  hardcoded in `CreativeAttentionPage`. Five missions in production
  ran at 1 respondent, providing no usable signal.
- Pass 25 Phase 0.3: respondent ladder shipped with min-respondent
  guard. Refunds for the 5 broken missions handled separately.
