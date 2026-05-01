/**
 * VETT — Creative Attention XLSX export.
 *
 * Sheets:
 *   1. Cover           — title, brief, meta
 *   2. Summary         — engagement gauge + brand strength scorecard + arc/benchmark
 *   3. Emotion peaks
 *   4. Strengths / Weaknesses / Recommendations  (one block per category, same sheet)
 *   5. Frames          — one row per frame_analysis
 *   6. Emotion Timeline — wide format, one column per emotion
 *   7. Platform Fit
 *
 * VETT palette via shared BRAND.
 */

const ExcelJS = require('exceljs');
const {
  BRAND, brandStrength, platformLabel, platformRationale, caExportFilename,
} = require('./shared');

const argb = (c) => 'FF' + (c || '').replace('#', '').toUpperCase();

function styleHeader(cell, color = BRAND.lime, bg = BRAND.bg) {
  cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: argb(color) } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(bg) } };
  cell.alignment = { vertical: 'middle', horizontal: 'left' };
}

function styleSectionTitle(cell, color = BRAND.lime) {
  cell.font = { name: 'Calibri', size: 14, bold: true, color: { argb: argb(color) } };
  cell.alignment = { vertical: 'middle', horizontal: 'left' };
}

async function buildCAXLSX(pack, res) {
  const { mission, analysis } = pack;
  const summary = analysis.summary || {};
  const frames = analysis.frame_analyses || [];

  const wb = new ExcelJS.Workbook();
  wb.creator = 'VETT';
  wb.lastModifiedBy = 'VETT';
  wb.created = new Date();
  wb.title = mission.title || 'VETT Creative Attention Report';

  // ── 1. COVER ────────────────────────────────────────────────
  const cover = wb.addWorksheet('Cover', {
    views: [{ showGridLines: false }],
    properties: { tabColor: { argb: argb(BRAND.lime) } },
  });
  cover.columns = [{ width: 28 }, { width: 60 }];

  cover.getCell('A1').value = 'VETT';
  cover.getCell('A1').font = { name: 'Calibri', size: 36, bold: true, color: { argb: argb(BRAND.lime) } };
  cover.getCell('A2').value = 'CREATIVE ATTENTION ANALYSIS';
  cover.getCell('A2').font = { name: 'Calibri', size: 10, bold: true, color: { argb: argb(BRAND.text2) } };

  cover.getCell('A4').value = mission.title || 'Creative Analysis';
  cover.getCell('A4').font = { name: 'Calibri', size: 18, bold: true };

  cover.getCell('A6').value = 'Brief';
  styleHeader(cover.getCell('A6'));
  cover.getCell('B6').value = mission.brief || mission.mission_statement || '';
  cover.getCell('B6').alignment = { wrapText: true, vertical: 'top' };

  const coverMeta = [
    ['Mission ID', mission.id],
    ['Media Type', mission.media_type || (analysis.is_video ? 'video' : 'image')],
    ['Total Frames', analysis.total_frames || frames.length],
    ['Generated At', analysis.generated_at || ''],
    ['Completed At', mission.completed_at || ''],
    ['Exported At', new Date().toISOString()],
  ];
  let r = 8;
  for (const [label, value] of coverMeta) {
    cover.getCell(`A${r}`).value = label;
    styleHeader(cover.getCell(`A${r}`));
    cover.getCell(`B${r}`).value = value == null ? '' : value;
    r += 1;
  }

  // ── 2. SUMMARY ──────────────────────────────────────────────
  const sumSheet = wb.addWorksheet('Summary', { views: [{ showGridLines: false }] });
  sumSheet.columns = [{ width: 32 }, { width: 16 }, { width: 60 }];

  sumSheet.getCell('A1').value = 'Engagement & Brand Strength';
  styleSectionTitle(sumSheet.getCell('A1'));

  const bs = brandStrength(analysis);
  const scoreRows = [
    ['Overall Engagement Score', summary.overall_engagement_score, '/ 100'],
    ['Engagement (avg frame score)', bs.engagement, '/ 100'],
    ['Resonance', bs.resonance, '/ 100'],
    ['Clarity', bs.clarity, '/ 100'],
    ['Memory', bs.memory, '/ 100 (synthesized: trust + surprise + anticipation)'],
  ];
  scoreRows.forEach((row, i) => {
    const rr = 3 + i;
    sumSheet.getCell(`A${rr}`).value = row[0];
    sumSheet.getCell(`B${rr}`).value = row[1];
    sumSheet.getCell(`C${rr}`).value = row[2];
    styleHeader(sumSheet.getCell(`A${rr}`), BRAND.text1, BRAND.bg2);
  });

  sumSheet.getCell('A10').value = 'Attention Arc';
  styleHeader(sumSheet.getCell('A10'));
  sumSheet.getCell('B10').value = summary.attention_arc || '';
  sumSheet.mergeCells('B10:C10');
  sumSheet.getCell('B10').alignment = { wrapText: true, vertical: 'top' };

  sumSheet.getCell('A11').value = 'vs Benchmark';
  styleHeader(sumSheet.getCell('A11'));
  sumSheet.getCell('B11').value = summary.vs_benchmark || '';
  sumSheet.mergeCells('B11:C11');
  sumSheet.getCell('B11').alignment = { wrapText: true, vertical: 'top' };

  // ── 3. EMOTION PEAKS ────────────────────────────────────────
  const peakSheet = wb.addWorksheet('Emotion Peaks', { views: [{ showGridLines: false }] });
  peakSheet.columns = [
    { header: 'Emotion', key: 'emotion', width: 18 },
    { header: 'Peak Timestamp (s)', key: 't', width: 18 },
    { header: 'Peak Value', key: 'v', width: 14 },
    { header: 'Interpretation', key: 'i', width: 70 },
  ];
  peakSheet.getRow(1).eachCell((c) => styleHeader(c));
  for (const p of summary.emotion_peaks || []) {
    peakSheet.addRow({
      emotion: p.emotion,
      t: p.peak_timestamp,
      v: p.peak_value,
      i: p.interpretation,
    });
  }

  // ── 4. NARRATIVE BLOCKS ─────────────────────────────────────
  const narrSheet = wb.addWorksheet('Strengths Weaknesses Recs', { views: [{ showGridLines: false }] });
  narrSheet.columns = [{ width: 18 }, { width: 6 }, { width: 90 }];
  let nr = 1;
  for (const [label, items] of [
    ['Strengths',       summary.strengths       || []],
    ['Weaknesses',      summary.weaknesses      || []],
    ['Recommendations', summary.recommendations || []],
  ]) {
    narrSheet.getCell(`A${nr}`).value = label;
    styleSectionTitle(narrSheet.getCell(`A${nr}`));
    nr += 1;
    items.forEach((text, i) => {
      narrSheet.getCell(`A${nr}`).value = '';
      narrSheet.getCell(`B${nr}`).value = i + 1;
      narrSheet.getCell(`C${nr}`).value = text;
      narrSheet.getCell(`C${nr}`).alignment = { wrapText: true, vertical: 'top' };
      nr += 1;
    });
    nr += 1;  // blank row between blocks
  }

  // ── 5. FRAMES ───────────────────────────────────────────────
  const fr = wb.addWorksheet('Frames', { views: [{ showGridLines: false }] });
  fr.columns = [
    { header: 'Timestamp (s)',     key: 't',  width: 14 },
    { header: 'Engagement',        key: 'e',  width: 12 },
    { header: 'Audience Resonance', key: 'r', width: 18 },
    { header: 'Message Clarity',   key: 'c',  width: 18 },
    { header: 'Attention Hotspots', key: 'h', width: 50 },
    { header: 'Brief Description', key: 'd',  width: 80 },
  ];
  fr.getRow(1).eachCell((c) => styleHeader(c));
  for (const f of frames) {
    fr.addRow({
      t: f.timestamp,
      e: f.engagement_score,
      r: f.audience_resonance,
      c: f.message_clarity,
      h: (f.attention_hotspots || []).join('; '),
      d: f.brief_description || '',
    });
  }
  fr.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    row.getCell(6).alignment = { wrapText: true, vertical: 'top' };
  });

  // ── 6. EMOTION TIMELINE ─────────────────────────────────────
  const emotionKeys = new Set();
  for (const f of frames) for (const k of Object.keys(f.emotions || {})) emotionKeys.add(k);
  const sortedEmotions = [...emotionKeys].sort();

  const tl = wb.addWorksheet('Emotion Timeline', { views: [{ showGridLines: false }] });
  tl.columns = [
    { header: 'Timestamp (s)', key: 't', width: 14 },
    ...sortedEmotions.map((k) => ({ header: k, key: k, width: 12 })),
  ];
  tl.getRow(1).eachCell((c) => styleHeader(c));
  for (const f of frames) {
    const row = { t: f.timestamp };
    for (const k of sortedEmotions) row[k] = (f.emotions || {})[k] ?? '';
    tl.addRow(row);
  }

  // ── 7. PLATFORM FIT ─────────────────────────────────────────
  const pf = wb.addWorksheet('Platform Fit', { views: [{ showGridLines: false }] });
  pf.columns = [
    { header: 'Platform', key: 'p', width: 24 },
    { header: 'Rationale', key: 'r', width: 90 },
  ];
  pf.getRow(1).eachCell((c) => styleHeader(c));
  for (const p of summary.best_platform_fit || []) {
    pf.addRow({ p: platformLabel(p), r: platformRationale(p) });
  }
  pf.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  });

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${caExportFilename(mission, 'xlsx')}"`,
  );

  await wb.xlsx.write(res);
  res.end();
}

module.exports = { buildCAXLSX };
