# Pass 27 — CA Export Audit

**Date:** 2026-05-05

## Symptom

Creative Attention missions had Export buttons that fell through to the
general-research templates from Pass 25 Phase 0 / 0.1, which DO NOT
render `creative_analysis`, `frame_analyses`, `attention`, or
`channel_benchmarks`. Output was empty or missed all the CA-specific
fields.

## Format-by-format

| Format | Status before Pass 27 | Status after Pass 27 H |
|---|---|---|
| PDF (pdf-v2) | ❌ general_research template | ✅ creative_attention.hbs body partial |
| PPTX (pptxgenjs) | ❌ general_research path | ⏸ Deferred — see below |
| XLSX (exceljs) | ❌ general_research path | ⏸ Deferred — see below |
| JSON (/export/raw) | ✅ Already returns mission row + creative_analysis | unchanged |
| CSV (frontend) | ❌ Not applicable to CA shape | ⏸ Deferred — see below |
| Targeting Brief MD | ✅ Already CA-aware | unchanged |

## What Pass 27 H ships

- New `pdf-v2/templates/creative_attention.hbs` body partial (6-9 pages)
- `bodyTemplateForMission` switch routes `creative_attention` to the
  new template
- View model exposes `ca` (= `mission.creative_analysis`),
  `media_url`, `brand_name` to the template
- New Handlebars `add` helper for frame numbering

PDF outline (8 pages):
1. Cover (existing _base.hbs cover)
2. Executive Summary + Engagement Score
3. Attention Metrics
4. 24-Emotion Analysis (no DAIVID name-drop per Pass 25 Phase 0.4)
5. Cross-Channel Benchmarks
6. Frame-by-Frame Breakdown
7. Strengths / Weaknesses / Recommendations
8. Methodology + Disclaimer

All Pass 25 Phase 0 + Pass 26 CSS rules apply (page-break-inside:
avoid, embedded fonts, font-display: block, lime headers, dark BG).

## Deferred (not in Pass 27 scope)

- **PPTX CA-specific deck (15 slides per spec).** Current PPTX builder
  emits a general-research deck for CA missions. Requires similar
  goal_type switch as the PDF + a `buildCAPPTX()` function with
  shape-based bars (Pass 26 lesson). Estimated 1-2 hours.
- **XLSX CA-specific workbook (6 sheets per spec).** Current XLSX
  builder emits the general-research workbook. Requires similar
  goal_type switch + a `buildCAXLSX()` with frame analysis sheet,
  emotion scores pivot, channel benchmarks sheet, raw JSON sheet.
  Estimated 1-2 hours.
- **CSV CA polish.** CA missions don't fit the question/response
  CSV shape; needs its own format (e.g. one row per frame with
  emotion columns). Estimated 30 min.

These 3 deferrals are tracked as separate follow-up tickets. PDF was
prioritized because it's the highest-leverage CA export — Jamil
specifically called out the broken PDF output for CA missions.

## Verification

For mission `3348d47b-…` (Balenciaga, has v2 `creative_analysis` shape):
- PDF should render 8 pages with all CA-specific sections populated
- Cover shows "Creative Attention: Balenciaga"
- Section 2 shows engagement score (was 70 last query)
- Section 3 shows 24 emotions ranked by aggregate score
- Section 4 shows channel_benchmarks rows
- Section 6 lists strengths / weaknesses / recommendations

For the 4 v1 CA missions (`5e1ea434`, `25343ca8`, `a24d3776`,
`f64eabcb`), some sections will be empty because v1 schema lacks
`attention`, `channel_benchmarks`, `creative_effectiveness`. The
template `{{#if}}` guards on each block handle this gracefully.
