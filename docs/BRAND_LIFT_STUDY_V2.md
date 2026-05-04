# Brand Lift Study v2

**Last updated:** 2026-05-04 (Pass 25 Phase 1)

## What it is

A research mission family for measuring brand awareness, recall,
favorability, consideration, intent, and advocacy lift around a
campaign. Synthetic respondents are simulated against a targeting
profile and a campaign-specific creative; outputs are funnel-stage
KPIs benchmarked against AI-estimated category norms.

`goal_type = 'brand_lift'` on the missions table.

## Setup flow (frontend)

1. Brief + clarify (existing /setup AI flow).
2. **Mandatory creative upload** (`CreativeUploader`) — image, video,
   or audio, max 100MB, stored in Supabase Storage at
   `brand-lift-creatives/{userId}/{folder}/{filename}`. Saved to
   `missions.creative_metadata`.
3. **Channel picker** (`ChannelPicker`) — granular MENA-first
   inventory loaded from `channels_master` (221 rows: TV, CTV, cinema,
   digital video, social, display, audio, radio, OOH, DOOH,
   influencer, press, retail media, in-game). AI-suggested chips with
   lime border. Custom channels per category. Min 1.
4. **Wave structure** (`WaveStructureSelector`) — single_wave,
   pre_post (creates 2 linked missions), or continuous (multi-wave).
5. **Competitor brands** (`CompetitorPicker`) — min 2, max 5. AI
   suggestion chips.
6. **KPI template** (`KPITemplatePicker`) — 8 templates: Funnel
   Overview (default), Brand Awareness Builder, Ad Recall Optimizer,
   Brand Perception Shift, Consideration Driver, Purchase Intent
   Generator, Creative Effectiveness, Multi-Market Comparison. AI
   auto-selects best fit.
7. Pricing slider (existing RespondentSlider, pre-existing brand_lift
   tier ladder).

## AI question generation

`src/services/claudeAI.js` system prompt extended in Pass 25 Phase 1D:

- Each brand_lift question carries `funnel_stage`, `kpi_category`,
  `is_lift_question`, optional `channel_id` (matching a channels_master
  id when the question is channel-specific).
- Existing 9-category framework coverage is preserved.
- Top-3 selected channels (by display_order) get channel-specific
  recall questions.
- Competitor brands surfaced in aided awareness / consideration
  multi-select option lists.
- KPI template adjusts category emphasis (Ad Recall Optimizer skips
  NPS, etc.).

## Results page

`src/pages/BrandLiftResultsPage.tsx` — wired into ResultsRouter for
`goal_type === 'brand_lift'`. Reads `mission.brand_lift_results` (jsonb)
for the pre-aggregated payload (see schema below). 10 components in
`src/components/brand-lift/`:

- BrandLiftScoreDial (radial)
- FunnelVisualization (with pre/post ghost bars)
- ChannelPerformanceTable + ChannelFilterDropdown
- GeographicBreakdown
- CreativeDiagnostic (reuses creative-attention components)
- CompetitorComparison
- AIRecommendationCard
- WaveComparison
- BenchmarkBadge

Mandatory disclaimer in the footer per the spec: *"Benchmarks are
AI-estimated based on category norms. They are directional, not
validated panel data. Use for orientation, not absolute claims."*

## brand_lift_results schema

```jsonc
{
  "score": 0-100,
  "band_label": "ELITE | STRONG | AVERAGE | WEAK | POOR",
  "band_explanation": "1-2 sentence AI explanation",
  "funnel": [{ "id", "label", "value": 0-100, "benchmark"? }],
  "pre_funnel": [...],          // pre_post only
  "channels": [{ "id", "display_name", "category", "ad_recall", "brand_lift", "insight"? }],
  "geography": [{ "region", "brand_lift", "n" }],
  "competitors": [{ "brand", "awareness", "consideration", "intent", "isFocal"? }],
  "waves": [{ "label", "values": [{ "kpi", "value" }] }],
  "wave_synthesis": "AI synthesis blurb",
  "recommendations": [{ "title", "body", "confidence", "explanation"? }]
}
```

## Benchmarks

`src/services/brandLiftBenchmarks.js` calls Claude Sonnet for AI-estimated
benchmark sets, cached per (industry, region_key, channel_mix_hash,
audience_segment, kpi_template) for 30 days. Endpoint
`GET /api/results/:id/brand-lift-benchmarks` wraps the service.
See `BENCHMARK_METHODOLOGY.md`.

## Schema lock

The Pass 25 Phase 0.1 PATCH guard rejects question / targeting /
respondent_count edits once responses exist on a mission, regardless
of goal_type. Verified for brand_lift via `test/brand_lift_schema_lock.test.js`.

## Exports

- **PDF**: `pdf-v2/templates/brand_lift_study.hbs` body partial wired
  into `bodyTemplateForMission`. 8-page outline (cover + summary + funnel
  + channels + geo + competitors + waves + recs + methodology).
- **PPTX, XLSX, CSV, JSON, Targeting Brief MD**: brand-lift-specific
  polish (15-slide PPTX deck, 8-sheet XLSX) deferred to a follow-up
  pass. The existing exporters render brand_lift missions through
  the general-research templates today; data is correct, layout is
  shared.

## Schema

Migration: `pass_25_phase_1_brand_lift_v2_schema` (migrations/pass-25/01).

New missions columns:
- `creative_metadata jsonb`
- `campaign_channels jsonb` (array of selected channel objects)
- `wave_config jsonb`
- `competitor_brands jsonb` (array of strings)
- `brand_lift_template text`
- `brand_lift_kpis jsonb`
- `linked_mission_ids uuid[]`
- `wave_number integer`

New tables:
- `brand_lift_benchmarks` — AI benchmark cache, 30-day TTL
- `channels_master` — static channel inventory (221 rows seeded)

## Out of scope (Pass 25)

- 15-slide PPTX deck
- Multi-format brand-lift exports (XLSX pivots, brief MD additions)
- Brand-lift-specific creative diagnostic component (reuses
  creative-attention components today)
- Heavy-map geo widget (bar list ships in v1)
- Respondent simulator changes for funnel-stage-aware response
  generation
