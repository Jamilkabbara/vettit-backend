# Incrementality (Pass 27)

**Last updated:** 2026-05-05

## What it measures

For brand_lift missions, VETT now generates **paired exposed/control
synthetic respondents**. The exposed group answers as if they had seen
the campaign creative on the selected channels; the control group
answers at category baseline. Lift on each KPI = exposed metric −
control metric.

## Schema

`mission_responses.exposure_status` ∈ `{exposed, control, not_applicable}`.
Default `not_applicable`. Only `brand_lift` missions populate
`exposed`/`control`. Index on `(mission_id, exposure_status)` for
fast filter aggregation.

## Simulator (Pass 27 F18)

- `runMission.js` for `brand_lift`: split personas 50/50 (Math.ceil
  for odd counts → first half exposed). Tag each persona with
  `_exposure_status`.
- `simulate.js` `simulateResponses`: prompts the model with an
  "Incrementality flag: this persona was EXPOSED" or "...CONTROL"
  block. Lift sizes calibrated to industry norms:
  - Aided ad recall: +20-40 pp
  - Brand awareness: +5-15 pp
  - Consideration: +3-10 pp
  - Purchase intent: +2-8 pp
  - NPS: +1-4 points
- The simulator is told NOT to push every metric to 100% — many
  exposed people still don't recall.

## Backfill caveat (pre-Pass-27 missions)

Existing brand_lift missions had no exposure_status. The Pass 27
backfill assigns exposure deterministically based on
`(mission_id || persona_id)` first character (~50/50 split). This
gives the BrandLiftResultsPage a usable signal but the lift values
are NOT real incrementality — they're a random-split visualization.
Future missions ship with the simulator-driven paired design.

The BrandLiftResultsPage footer disclaimer surfaces this:

> Incrementality estimates use a paired exposed/control synthetic
> respondent design. Lift values are directional, not validated panel
> data.

## Filter UI

`IncrementalityFilterDropdown` modes:
- **All respondents** (default)
- **Exposed only** — filter to `exposure_status = 'exposed'`
- **Control only** — filter to `exposure_status = 'control'`
- **Show lift** — every metric renders Exposed − Control deltas
  with `+12.5pp` notation; tooltip explains the formula.

## Files

- Schema: `migrations/pass-27/04_incrementality_schema.sql`
- Backfill: `migrations/pass-27/05_backfill_brand_lift.sql`
- Simulator changes: `src/jobs/runMission.js` + `src/services/ai/simulate.js`
- Tests: `test/incrementality_simulator.test.js`
- UI: `src/components/brand-lift/filters/FilterDropdowns.tsx`
