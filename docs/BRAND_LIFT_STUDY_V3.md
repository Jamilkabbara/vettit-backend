# Brand Lift Study v3

**Last updated:** 2026-05-05 (Pass 27.5)
**goal_type:** `brand_lift`

A research mission family for measuring brand awareness, recall,
favorability, consideration, intent, and advocacy lift around a
campaign. v3 adds markets as first-class taxonomy, granular channel
selection, waves, paired exposed/control incrementality design,
demographic filters on results, and tiered pricing.

## 1. Markets

The setup flow opens with a `MarketPicker` (renders ABOVE the
ChannelPicker). Users select 1+ markets; selecting a meta-market
(MENA, NORTH_AMERICA, EUROPE, etc.) expands to its constituent
countries. See `MARKETS_DIRECTORY.md` for the full list (97 rows:
10 meta + 87 countries).

Each selected market drives:
- Channel filtering — only channels with that market in `markets[]`
  appear in the picker (or `is_global = TRUE` rows always show).
- Pricing — market count drives the market_uplift tier (see
  `PRICING.md`).
- Persona simulation — synthetic respondents are drawn from those
  markets' demographic profiles.

## 2. Channel selection

`ChannelPicker` reads `channels_master` (~590 channels post Pass
27.5) filtered by `markets && selectedMarkets OR is_global = TRUE`.
14 categories: tv, ctv, cinema, digital_video, social, display,
audio, radio, ooh, dooh, influencer, press, retail_media, in_game.
Min 1 channel required. Tier counter at the bottom shows the
channel_uplift band.

Custom channels: per-category text input adds a custom row with
`custom: true` (won't be in channels_master). Stored on the
mission's `campaign_channels` JSONB.

Long tail: 590 → 800+ deferred — incremental adds, no schema
change. See `CHANNELS_MASTER_LIST.md`.

## 3. Wave structure

`WaveStructureSelector` offers three modes:
- `single_wave` — one snapshot post-campaign (no comparison)
- `pre_post` — two missions, one before launch, one after; linked
  via `linked_mission_ids` UUID array
- `continuous` — multi-wave with fixed intervals (2/4/6/8/12 weeks)

Date validation: campaign_end > campaign_start.

## 4. Incrementality (paired exposed/control)

Exposed/control split is the default for brand_lift missions as of
Pass 27. The simulator generates ~50/50 paired samples per
mission; the prompt instructs the model to lift exposed-group
metrics by realistic ranges (aided recall +20-40pp, brand awareness
+5-15pp, consideration +3-10pp, intent +2-8pp, NPS +1-4 points).
Never pushes every metric to 100%.

Lift = exposed metric − control metric. See `INCREMENTALITY.md`
for details, simulator code paths, and the pre-Pass-27 backfill
caveat.

`mission_responses.exposure_status ∈ {exposed, control,
not_applicable}`. Other goal types stay at `not_applicable`.

## 5. Demographic filtering on results

`BrandLiftResultsPage` exposes 7 filter dimensions (Pass 27 F19+F20
+ Pass 27.5 D wire-up):
- Markets — filter to specific markets
- Channels — single-channel deep dive
- Channel categories — TV-only / Social-only / etc.
- Gender — male / female / non-binary
- Age groups — 18-24 / 25-34 / 35-44 / 45-54 / 55-64 / 65+
- Incrementality — All / Exposed / Control / Show lift
- Wave — single wave or specific wave for multi-wave missions

AND composition: filter axes intersect. Filter state debounces
200ms before refetching `/api/results/:id?<params>`.

Lift mode renders metric pairs `{exposed, control, delta_pp}`
and a `lift_mode: true` badge in the filter row.

Empty filter result (zero respondents) renders an inline
"no respondents match" caption with a Reset button.

## 6. Pricing tiers

Three layers compose:
- **Respondent base** — Sniff Test 5/$9 → Enterprise 5000/$1990
  (mirrors validate ladder)
- **Market uplift** — 1 free / 2-3 +$10 / 4-7 +$25 / 8-15 +$50 /
  16+ +$100
- **Channel uplift** — 1-10 free / 11-25 +$10 / 26-50 +$20 /
  51-100 +$35 / 101+ +$50

See `PRICING.md` for tables + worked examples.

Backend persists `missions.price_breakdown` JSONB at payment time
with `ladder_version: 'pass_27_v1'` for retroactive re-pricing.

Validation: `POST /api/missions` rejects brand_lift with no
markets (400 markets_required) or no channels (400
channels_required).

## 7. Export formats

| Format | Status |
|---|---|
| PDF | ✅ Brand-lift-specific template (Pass 25 Phase 1G, 8 pages) |
| XLSX | ✅ Brand-lift-specific multi-sheet workbook (Pass 25 Phase 1G) |
| JSON `/export/raw` | ✅ Full mission + creative_analysis dump |
| Targeting Brief MD | ✅ AI-generated paid-media brief |
| PPTX | ⏸ Falls through to general_research; Brand-Lift PPTX deck deferred |
| CSV | ⏸ Falls through to general_research; Brand-Lift CSV deferred |

The CA exports also have CA-specific PDF (Pass 27 H) and XLSX
(Pass 27.5 B) templates as of this pass.

## 8. Schema lock

The Pass 25 Phase 0.1 PATCH guard rejects edits to questions /
targeting / respondent_count once `mission_responses` rows exist
on a brand_lift mission (or any mission). Returns 409
`schema_locked_after_responses`. Verified by
`test/brand_lift_schema_lock.test.js` (Pass 25 Phase 1H).

## Cross-references

- `MARKETS_DIRECTORY.md` — markets_master taxonomy
- `CHANNELS_MASTER_LIST.md` — channels_master inventory
- `PRICING.md` — full tier tables + worked examples
- `INCREMENTALITY.md` — paired exposed/control methodology
- `BENCHMARK_METHODOLOGY.md` — AI benchmark service contract
- `ADMIN_COSTS_PANEL.md` — economics panel covering brand_lift

## Out of scope (deferred)

- Brand-Lift-specific PPTX deck (15 slides per spec)
- Brand-Lift-specific CSV bundle
- Per-section re-render of score dial / funnel / channel table on
  filter change (Pass 27.5 D ships the refetch + counts; full
  per-section re-render needs a respondent-subset aggregator that
  produces brand_lift_results-shaped output for an arbitrary
  filtered slice — its own scope)
- AI recommendation regeneration per filter slice
