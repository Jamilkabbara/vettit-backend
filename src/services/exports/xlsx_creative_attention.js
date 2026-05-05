/**
 * Pass 27.5 B — Creative Attention XLSX exporter.
 *
 * Closes the gap from Pass 27 H (PDF shipped, XLSX/PPTX deferred).
 * CA missions had Export → XLSX buttons that fell through to the
 * general-research template which renders nothing meaningful for
 * creative_analysis-shaped data.
 *
 * 6 sheets (per Pass 27.5 spec):
 *   1. Cover            — brand name + title + summary in merged cells
 *   2. Frame Analysis   — per-frame rows × (timestamp, engagement,
 *                          top emotion, 24 emotion scores, narrative,
 *                          verbatim) with frozen header + conditional
 *                          formatting on engagement column
 *   3. Cross-Channel    — per-channel norm vs predicted with delta
 *      Benchmarks         conditional formatting
 *   4. Emotion Scores   — 24-emotion pivot, per-frame columns,
 *                          3-color gradient
 *   5. S/W/Recs         — three-column wrapped bullets
 *   6. Raw JSON         — full creative_analysis dump,
 *                          sheet-protected against edits
 *
 * Uses ExcelJS (matches existing xlsx.js — Pass 27.5 spec said openpyxl
 * but the actual codebase is ExcelJS; technology no-swap rule applies).
 */

const ExcelJS = require('exceljs');
const { BRAND } = require('./shared');
const { getReportMetadata } = require('./reportMetadata');

const argb = (c) => 'FF' + (c || '').replace('#', '').toUpperCase();

// 24-emotion framework order: 8 basic Plutchik + 16 nuanced research-derived.
// Same order as src/types/creativeAnalysis.ts EMOTION_TAXONOMY_V2.
const EMOTION_ORDER = [
  // Plutchik 8
  'joy', 'trust', 'fear', 'surprise', 'sadness', 'disgust', 'anger', 'anticipation',
  // Nuanced 16
  'amusement', 'awe', 'contentment', 'pride', 'love', 'satisfaction', 'relief', 'serenity',
  'shame', 'embarrassment', 'guilt', 'contempt', 'envy', 'boredom', 'confusion', 'nostalgia',
];

function styleHeader(cell) {
  cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: argb(BRAND.lime) } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(BRAND.bg) } };
  cell.alignment = { vertical: 'middle', horizontal: 'left' };
  cell.border = {
    top: { style: 'thin', color: { argb: argb(BRAND.border) } },
    bottom: { style: 'thin', color: { argb: argb(BRAND.border) } },
  };
}

function topEmotion(emotions = {}) {
  let bestKey = '', bestVal = -Infinity;
  for (const [k, v] of Object.entries(emotions)) {
    if (typeof v === 'number' && v > bestVal) { bestVal = v; bestKey = k; }
  }
  return bestKey;
}

async function buildCreativeAttentionXLSX(pack, res) {
  const { mission } = pack;
  const ca = mission.creative_analysis || {};
  const frames = Array.isArray(ca.frame_analyses) ? ca.frame_analyses : [];
  const benchmarks = Array.isArray(ca.channel_benchmarks) ? ca.channel_benchmarks : [];
  const meta = getReportMetadata(mission);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'VETT';
  wb.title = mission.title || 'VETT Creative Attention Report';
  wb.created = new Date();

  // ── 1. COVER ────────────────────────────────────────────────────
  const cover = wb.addWorksheet('Cover', {
    views: [{ showGridLines: false }],
    properties: { tabColor: { argb: argb(BRAND.lime) } },
  });
  cover.columns = [{ width: 28 }, { width: 28 }, { width: 28 }, { width: 28 }];

  cover.mergeCells('A1:D2');
  const title = cover.getCell('A1');
  title.value = 'VETT';
  title.font = { name: 'Calibri', size: 36, bold: true, color: { argb: argb(BRAND.lime) } };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(BRAND.bg) } };
  title.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

  cover.mergeCells('A3:D3');
  const sub = cover.getCell('A3');
  sub.value = 'CREATIVE ATTENTION ANALYSIS';
  sub.font = { name: 'Calibri', size: 10, bold: true, color: { argb: argb(BRAND.text2) } };
  sub.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

  cover.mergeCells('A5:D6');
  const brandTitle = cover.getCell('A5');
  brandTitle.value = mission.brand_name || mission.title || 'Creative Attention';
  brandTitle.font = { name: 'Calibri', size: 22, bold: true };
  brandTitle.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

  cover.mergeCells('A8:D8');
  const m1 = cover.getCell('A8');
  m1.value = `Mission completed: ${meta.mission_completed_label}`;
  m1.font = { name: 'Calibri', size: 10, color: { argb: argb(BRAND.text2) } };

  cover.mergeCells('A9:D9');
  const m2 = cover.getCell('A9');
  m2.value = `Report generated: ${meta.report_generated_label}`;
  m2.font = { name: 'Calibri', size: 10, color: { argb: argb(BRAND.text2) } };

  cover.mergeCells('A10:D10');
  const m3 = cover.getCell('A10');
  m3.value = `Mission ID: ${mission.id}`;
  m3.font = { name: 'Calibri', size: 10, color: { argb: argb(BRAND.text3) } };

  if (ca.summary?.attention_arc) {
    cover.mergeCells('A12:D20');
    const summary = cover.getCell('A12');
    summary.value = ca.summary.attention_arc;
    summary.font = { name: 'Calibri', size: 11 };
    summary.alignment = { wrapText: true, vertical: 'top' };
  }

  if (typeof ca.summary?.overall_engagement_score === 'number') {
    cover.getCell('A22').value = 'Engagement Score';
    cover.getCell('A22').font = { name: 'Calibri', size: 10, bold: true, color: { argb: argb(BRAND.text2) } };
    cover.getCell('B22').value = `${ca.summary.overall_engagement_score} / 100`;
    cover.getCell('B22').font = { name: 'Calibri', size: 16, bold: true, color: { argb: argb(BRAND.lime) } };
  }

  // ── 2. FRAME ANALYSIS ───────────────────────────────────────────
  const frameSheet = wb.addWorksheet('Frame Analysis', {
    properties: { tabColor: { argb: argb(BRAND.lime) } },
    views: [{ state: 'frozen', xSplit: 0, ySplit: 1 }],
  });
  const frameHeaders = [
    'Frame', 'Timestamp (s)', 'Engagement', 'Top emotion',
    ...EMOTION_ORDER, 'Narrative', 'Verbatim',
  ];
  frameSheet.addRow(frameHeaders);
  frameSheet.getRow(1).eachCell((c) => styleHeader(c));
  frameSheet.columns = [
    { width: 8 }, { width: 14 }, { width: 12 }, { width: 18 },
    ...EMOTION_ORDER.map(() => ({ width: 12 })),
    { width: 60 }, { width: 50 },
  ];

  frames.forEach((f, i) => {
    const emotions = f.emotions || {};
    const row = [
      i + 1,
      f.timestamp ?? '',
      f.engagement_score ?? '',
      topEmotion(emotions),
      ...EMOTION_ORDER.map((k) => (typeof emotions[k] === 'number' ? emotions[k] : '')),
      f.narrative || '',
      f.verbatim || '',
    ];
    frameSheet.addRow(row);
  });

  // Conditional formatting on Engagement column (col C):
  if (frames.length > 0) {
    const engCol = `C2:C${frames.length + 1}`;
    frameSheet.addConditionalFormatting({
      ref: engCol,
      rules: [
        { type: 'cellIs', operator: 'greaterThanOrEqual', formulae: ['70'], priority: 1,
          style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: argb(BRAND.lime) } } } },
        { type: 'cellIs', operator: 'between', formulae: ['40', '69'], priority: 2,
          style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFB923C' } } } },
        { type: 'cellIs', operator: 'lessThan', formulae: ['40'], priority: 3,
          style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFF87171' } } } },
      ],
    });
  }

  // ── 3. CROSS-CHANNEL BENCHMARKS ─────────────────────────────────
  const benchSheet = wb.addWorksheet('Cross-Channel Benchmarks', {
    properties: { tabColor: { argb: argb(BRAND.lime) } },
  });
  benchSheet.addRow(['Channel', 'Format', 'Norm (s)', 'Predicted (s)', 'Delta %', 'Assessment', 'Format match']);
  benchSheet.getRow(1).eachCell((c) => styleHeader(c));
  benchSheet.columns = [
    { width: 32 }, { width: 16 }, { width: 12 }, { width: 14 }, { width: 12 }, { width: 50 }, { width: 14 },
  ];
  benchmarks.forEach((b) => {
    benchSheet.addRow([
      b.channel || '',
      b.format || '',
      b.norm_seconds ?? '',
      b.predicted_seconds ?? '',
      b.delta_pct ?? '',
      b.assessment || '',
      b.format_match === true ? 'Yes' : b.format_match === false ? 'No' : '—',
    ]);
  });
  if (benchmarks.length > 0) {
    benchSheet.addConditionalFormatting({
      ref: `E2:E${benchmarks.length + 1}`,
      rules: [
        { type: 'cellIs', operator: 'greaterThanOrEqual', formulae: ['0'], priority: 1,
          style: { font: { color: { argb: argb(BRAND.lime) } } } },
        { type: 'cellIs', operator: 'lessThan', formulae: ['0'], priority: 2,
          style: { font: { color: { argb: 'FFFB923C' } } } },
      ],
    });
  }

  // ── 4. EMOTION SCORES PIVOT ─────────────────────────────────────
  const emoSheet = wb.addWorksheet('Emotion Scores', {
    properties: { tabColor: { argb: argb(BRAND.lime) } },
  });
  const emoHeaderRow = ['Emotion', 'Aggregate', ...frames.map((_, i) => `Frame ${i + 1}`)];
  emoSheet.addRow(emoHeaderRow);
  emoSheet.getRow(1).eachCell((c) => styleHeader(c));
  emoSheet.columns = [
    { width: 18 }, { width: 12 },
    ...frames.map(() => ({ width: 10 })),
  ];
  EMOTION_ORDER.forEach((emo) => {
    const perFrameVals = frames.map((f) =>
      typeof (f.emotions || {})[emo] === 'number' ? f.emotions[emo] : null);
    const numericVals = perFrameVals.filter((v) => typeof v === 'number');
    const aggregate = numericVals.length > 0
      ? Math.round(numericVals.reduce((s, v) => s + v, 0) / numericVals.length)
      : '';
    emoSheet.addRow([emo, aggregate, ...perFrameVals.map((v) => v ?? '')]);
  });
  // 3-color gradient on score cells (col B onwards, 24 emotion rows)
  if (frames.length > 0 || EMOTION_ORDER.length > 0) {
    const lastCol = String.fromCharCode(65 + 1 + frames.length); // B + frames
    emoSheet.addConditionalFormatting({
      ref: `B2:${lastCol}${EMOTION_ORDER.length + 1}`,
      rules: [{
        type: 'colorScale', priority: 1,
        cfvo: [
          { type: 'min' },
          { type: 'percentile', value: 50 },
          { type: 'max' },
        ],
        color: [
          { argb: 'FFF87171' }, // red
          { argb: 'FFFB923C' }, // amber
          { argb: argb(BRAND.lime) }, // lime
        ],
      }],
    });
  }

  // ── 5. STRENGTHS / WEAKNESSES / RECOMMENDATIONS ────────────────
  const swrSheet = wb.addWorksheet('Strengths Weaknesses Recs', {
    properties: { tabColor: { argb: argb(BRAND.lime) } },
  });
  swrSheet.columns = [{ width: 50 }, { width: 50 }, { width: 50 }];
  swrSheet.addRow(['Strengths', 'Weaknesses', 'Recommendations']);
  swrSheet.getRow(1).eachCell((c) => styleHeader(c));
  const strengths = (ca.summary?.strengths || []).map((s) => `• ${s}`).join('\n');
  const weaknesses = (ca.summary?.weaknesses || []).map((s) => `• ${s}`).join('\n');
  const recs = (ca.summary?.recommendations || []).map((s) => `• ${s}`).join('\n');
  const swrRow = swrSheet.addRow([strengths, weaknesses, recs]);
  swrRow.height = 200;
  swrRow.eachCell((c) => {
    c.alignment = { wrapText: true, vertical: 'top' };
    c.font = { name: 'Calibri', size: 10 };
  });

  // ── 6. RAW JSON ─────────────────────────────────────────────────
  const rawSheet = wb.addWorksheet('Raw JSON', {
    properties: { tabColor: { argb: argb(BRAND.text3) } },
  });
  rawSheet.columns = [{ width: 120 }];
  rawSheet.getCell('A1').value = JSON.stringify(ca, null, 2);
  rawSheet.getCell('A1').alignment = { wrapText: true, vertical: 'top' };
  rawSheet.getCell('A1').font = { name: 'Courier New', size: 9 };
  rawSheet.getRow(1).height = 400;
  // Sheet-level protection (Excel will warn before edits)
  rawSheet.protect('vett-readonly', { selectLockedCells: true, selectUnlockedCells: true });

  // Stream
  const fname = `vett-creative-attention-${(mission.brand_name || mission.id).toString()
    .slice(0, 40).replace(/[^a-z0-9]+/gi, '-')}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  return wb.xlsx.write(res).then(() => res.end());
}

module.exports = { buildCreativeAttentionXLSX };
