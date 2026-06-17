/**
 * VETT — Excel export using exceljs.
 *
 * Pass 48 Phase 3 — REBUILT on the CanonicalReport. Every sheet renders
 * the SAME report the web results page renders (buildCanonicalReport →
 * buildRenderModel), in the uniform order shared by all export formats:
 *
 *   1. Report          — header (title+brief+sample) → exec summary →
 *                        headline metrics → centerpiece instrument
 *                        (brand-lift exposed/control funnel) → key findings
 *   2. Full survey     — EVERY question rendered by its renderer with the
 *                        CORRECT scale (0-10 NPS shows 0-10, 1-7 CES shows
 *                        1-7, attribute battery shows a per-attribute table,
 *                        max_diff shows best/worst). This is the fix that
 *                        kills the export "7/5" / "0/5" bug.
 *   3. Raw responses   — every persona/question row (data-science use).
 *   4. Demographic breakdown — age / country / gender / occupation tables.
 *   5. Data quality notes — the canonical (cleaned, one-per-question) notes.
 *
 * The OLD per-question 5-star Summary sheet and the spammy integrity-warning
 * sheet are GONE — the canonical report's correctly-shaped survey and cleaned
 * data-quality notes replace them.
 *
 * Dark-theme styling isn't truly visual in spreadsheets, but we adopt the
 * VETT palette for headers and banding so the file feels on-brand.
 */

const ExcelJS = require('exceljs');
const { BRAND } = require('./shared');
const { buildCanonicalReport } = require('../report/buildReport');
const { buildRenderModel } = require('../report/reportRenderModel');

// exceljs uses ARGB with leading alpha FF
const argb = (c) => 'FF' + (c || '').replace('#', '').toUpperCase();
const BAND = 'FFF8F9FC';

function styleHeader(cell, color = BRAND.lime, bg = BRAND.bg) {
  cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: argb(color) } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(bg) } };
  cell.alignment = { vertical: 'middle', horizontal: 'left' };
  cell.border = {
    top:    { style: 'thin', color: { argb: argb(BRAND.border) } },
    bottom: { style: 'thin', color: { argb: argb(BRAND.border) } },
    left:   { style: 'thin', color: { argb: argb(BRAND.border) } },
    right:  { style: 'thin', color: { argb: argb(BRAND.border) } },
  };
}

/** Clean responses the same way results.js /report does (mirror the web). */
function cleanResponses(responses) {
  const all = responses || [];
  const clean = all.filter((r) =>
    r && r.screened_out !== true && !(r.persona_profile && r.persona_profile.screened_out === true));
  return clean.length > 0 ? clean : all;
}

function buildXLSX(pack, res) {
  const { mission, responses } = pack;

  // STEP 1 — build the canonical report once, then the shared render model.
  const report = buildCanonicalReport(mission, mission.analysis || null, cleanResponses(responses));
  const model = buildRenderModel(report);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'VETT';
  wb.lastModifiedBy = 'VETT';
  wb.created = new Date();
  wb.title = model.header.title || 'VETT Research Report';

  // ── SHEET 1: REPORT (header → exec → headline → centerpiece → findings) ──
  const rep = wb.addWorksheet('Report', {
    views: [{ showGridLines: false }],
    properties: { tabColor: { argb: argb(BRAND.lime) } },
  });
  rep.columns = [{ width: 42 }, { width: 30 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 16 }];

  rep.mergeCells('A1:F1');
  const wm = rep.getCell('A1');
  wm.value = 'VETT  ·  AI-POWERED MARKET RESEARCH';
  wm.font = { name: 'Calibri', size: 12, bold: true, color: { argb: argb(BRAND.lime) } };

  rep.mergeCells('A2:F3');
  const titleCell = rep.getCell('A2');
  titleCell.value = model.header.title;
  titleCell.font = { name: 'Calibri', size: 20, bold: true };
  titleCell.alignment = { vertical: 'middle', wrapText: true };

  let row = 5;
  // §5 — the finding leads the summary sheet (the one-line takeaway).
  if (model.finding) {
    rep.mergeCells(`A${row}:F${row + 1}`);
    const f = rep.getCell(`A${row}`);
    f.value = model.finding;
    f.font = { name: 'Calibri', size: 13, bold: true, color: { argb: argb(BRAND.lime) } };
    f.alignment = { vertical: 'top', wrapText: true };
    row += 3;
  }
  // §2.4 — directional banner: never let a small-n number read as authoritative.
  if (model.gate && model.gate.posture === 'directional' && model.gate.note) {
    rep.mergeCells(`A${row}:F${row + 1}`);
    const g = rep.getCell(`A${row}`);
    g.value = `⚠ DIRECTIONAL — ${model.gate.note}${model.gate.n ? ` (n=${model.gate.n})` : ''}`;
    g.font = { name: 'Calibri', size: 10, bold: true, color: { argb: argb(BRAND.amber) } };
    g.alignment = { vertical: 'top', wrapText: true };
    row += 3;
  }
  if (model.header.brief) {
    rep.mergeCells(`A${row}:F${row + 2}`);
    const briefCell = rep.getCell(`A${row}`);
    briefCell.value = model.header.brief;
    briefCell.font = { name: 'Calibri', size: 11, color: { argb: argb(BRAND.text3) } };
    briefCell.alignment = { vertical: 'top', wrapText: true };
    row += 4;
  }

  // Sample / meta strip
  model.header.metaRows.forEach(([k, v]) => {
    const a = rep.getCell(`A${row}`); a.value = k;
    a.font = { name: 'Calibri', size: 10, bold: true, color: { argb: argb(BRAND.text2) } };
    const b = rep.getCell(`B${row}`); b.value = v;
    b.font = { name: 'Calibri', size: 10 };
    row += 1;
  });
  row += 1;

  // VETT Synthesis (canonical synthesis/exec_summary; no "fuller narrative" hedge)
  rep.getCell(`A${row}`).value = 'VETT SYNTHESIS';
  rep.getCell(`A${row}`).font = { name: 'Calibri', size: 11, bold: true, color: { argb: argb(BRAND.lime) } };
  row += 1;
  rep.mergeCells(`A${row}:F${row + 4}`);
  const es = rep.getCell(`A${row}`);
  es.value = model.synthesis || model.execSummary || 'Synthesis not available for this mission.';
  es.font = { name: 'Calibri', size: 11 };
  es.alignment = { vertical: 'top', wrapText: true };
  row += 6;

  // Headline metrics (the methodology's key computed numbers)
  if (model.headline) {
    rep.getCell(`A${row}`).value = 'HEADLINE METRICS';
    rep.getCell(`A${row}`).font = { name: 'Calibri', size: 11, bold: true, color: { argb: argb(BRAND.lime) } };
    row += 1;
    const hHdr = rep.getRow(row);
    hHdr.getCell(1).value = 'Metric'; hHdr.getCell(2).value = 'Value';
    [1, 2].forEach((c) => styleHeader(hHdr.getCell(c)));
    row += 1;
    model.headline.all.forEach((m, i) => {
      const r = rep.getRow(row);
      r.getCell(1).value = m.label;
      r.getCell(2).value = m.value;
      r.getCell(2).font = { name: 'Calibri', size: 11, bold: true };
      if (i % 2 === 0) [1, 2].forEach((c) => { r.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } }; });
      row += 1;
    });
    row += 1;
  }

  // Centerpiece instrument (brand-lift exposed/control funnel — full, all stages)
  if (model.centerpiece) {
    rep.getCell(`A${row}`).value = model.centerpiece.title.toUpperCase();
    rep.getCell(`A${row}`).font = { name: 'Calibri', size: 11, bold: true, color: { argb: argb(BRAND.lime) } };
    row += 1;
    const cHdr = rep.getRow(row);
    model.centerpiece.columns.forEach((c, i) => { cHdr.getCell(i + 1).value = c; styleHeader(cHdr.getCell(i + 1)); });
    row += 1;
    model.centerpiece.rows.forEach((cells, ri) => {
      const r = rep.getRow(row);
      cells.forEach((v, ci) => { r.getCell(ci + 1).value = v; });
      if (ri % 2 === 0) cells.forEach((_, ci) => { r.getCell(ci + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } }; });
      row += 1;
    });
    row += 1;
  }

  // Key findings
  if (model.keyFindings.length > 0) {
    rep.getCell(`A${row}`).value = 'KEY FINDINGS';
    rep.getCell(`A${row}`).font = { name: 'Calibri', size: 11, bold: true, color: { argb: argb(BRAND.lime) } };
    row += 1;
    model.keyFindings.forEach((f) => {
      rep.mergeCells(`A${row}:F${row}`);
      const t = rep.getCell(`A${row}`);
      t.value = f.value ? `• ${f.title}: ${f.value}` : `• ${f.title}`;
      t.font = { name: 'Calibri', size: 11, bold: true };
      row += 1;
      if (f.body) {
        rep.mergeCells(`A${row}:F${row}`);
        const b = rep.getCell(`A${row}`);
        b.value = f.body;
        b.font = { name: 'Calibri', size: 10, color: { argb: argb(BRAND.text3) } };
        b.alignment = { wrapText: true };
        row += 1;
      }
    });
    row += 1;
  }

  // Recommendations (B1)
  if (Array.isArray(model.recommendations) && model.recommendations.length > 0) {
    rep.getCell(`A${row}`).value = 'RECOMMENDATIONS';
    rep.getCell(`A${row}`).font = { name: 'Calibri', size: 11, bold: true, color: { argb: argb(BRAND.lime) } };
    row += 1;
    model.recommendations.forEach((r, i) => {
      rep.mergeCells(`A${row}:F${row}`);
      const c = rep.getCell(`A${row}`);
      c.value = `${i + 1}. ${r}`;
      c.font = { name: 'Calibri', size: 10 };
      c.alignment = { wrapText: true, vertical: 'top' };
      row += 1;
    });
    row += 1;
  }

  // ── SHEET 2: FULL SURVEY (every question, correct renderer + scale) ──
  const sv = wb.addWorksheet('Full survey', {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { tabColor: { argb: argb(BRAND.lime) } },
  });
  sv.columns = [
    { header: 'Q',        key: 'q',        width: 6  },
    { header: 'Question', key: 'question', width: 50 },
    { header: 'Renderer', key: 'renderer', width: 18 },
    { header: 'Answer / attribute', key: 'answer', width: 38 },
    { header: 'Value',    key: 'value',    width: 16 },
    { header: 'Share',    key: 'share',    width: 10 },
  ];
  sv.getRow(1).eachCell((c) => styleHeader(c));

  model.survey.forEach((q) => {
    // Question header row.
    const qRow = sv.addRow({
      q: `Q${q.number}`,
      question: q.text + (q.isScreening ? '  (screener)' : ''),
      renderer: q.renderer_label,
      answer: '', value: '', share: '',
    });
    qRow.getCell('question').font = { name: 'Calibri', size: 11, bold: true };
    qRow.getCell('q').font = { name: 'Calibri', size: 11, bold: true, color: { argb: argb(BRAND.lime) } };

    const body = q.body;
    if (body.kind === 'scale') {
      sv.addRow({ q: '', question: '', renderer: '', answer: body.headline, value: '', share: '' });
      body.bars.forEach((bar) => {
        sv.addRow({ q: '', question: '', renderer: '', answer: bar.label, value: bar.count, share: `${bar.pct}%` });
      });
    } else if (body.kind === 'matrix') {
      sv.addRow({ q: '', question: '', renderer: '', answer: `Per-attribute averages (n=${body.n})`, value: '', share: '' });
      body.rows.forEach((mr) => {
        sv.addRow({ q: '', question: '', renderer: '', answer: mr.label, value: mr.average, share: `n=${mr.n}` });
      });
    } else if (body.kind === 'maxdiff') {
      if (body.empty) {
        sv.addRow({ q: '', question: '', renderer: '', answer: body.empty_message, value: '', share: '' });
      } else {
        sv.addRow({ q: '', question: '', renderer: '', answer: 'Feature (best / worst counts)', value: '', share: '' });
        body.rows.forEach((mr) => {
          sv.addRow({ q: '', question: '', renderer: '', answer: mr.label, value: `best ${mr.best}`, share: `worst ${mr.worst}` });
        });
      }
    } else if (body.kind === 'verbatims') {
      if (body.empty) {
        sv.addRow({ q: '', question: '', renderer: '', answer: body.empty_message, value: '', share: '' });
      } else {
        // P2-1 — open-end themes as frequency rows (the open-end's data block),
        // then the raw verbatims beneath.
        if (body.has_themes) {
          sv.addRow({ q: '', question: '', renderer: '', answer: `Themes (n=${body.n})`, value: 'count', share: 'share' });
          body.themes.forEach((t) => {
            sv.addRow({ q: '', question: '', renderer: '', answer: `${t.label} (${t.sentiment})`, value: t.count, share: `${t.pct}%` });
          });
        }
        sv.addRow({ q: '', question: '', renderer: '', answer: `Verbatims (n=${body.n})`, value: '', share: '' });
        body.items.forEach((v) => {
          sv.addRow({ q: '', question: '', renderer: '', answer: String(v), value: '', share: '' });
        });
      }
    } else { // bars (choice / multi / endorsement)
      if (body.empty) {
        sv.addRow({ q: '', question: '', renderer: '', answer: body.empty_message, value: '', share: '' });
      } else {
        if (body.note) sv.addRow({ q: '', question: '', renderer: '', answer: body.note, value: '', share: '' });
        body.bars.forEach((bar) => {
          sv.addRow({ q: '', question: '', renderer: '', answer: bar.label, value: bar.count, share: `${bar.pct}%` });
        });
      }
    }
    // Pass 49 — per-question "what this means" (same canonical insight).
    if (q.insight) {
      const iRow = sv.addRow({ q: '', question: 'What this means:', renderer: '', answer: q.insight, value: '', share: '' });
      iRow.getCell('question').font = { name: 'Calibri', size: 10, italic: true, color: { argb: argb(BRAND.lime) } };
      iRow.getCell('answer').font = { name: 'Calibri', size: 10, italic: true };
    }
    sv.addRow({}); // spacer
  });

  // ── SHEET 3: RAW RESPONSES ──────────────────────────────────
  const raw = wb.addWorksheet('Raw responses', {
    properties: { tabColor: { argb: argb(BRAND.lime) } },
  });
  raw.columns = [
    { header: 'Persona ID', key: 'persona_id', width: 14 },
    { header: 'Age',        key: 'age',        width: 8  },
    { header: 'Gender',     key: 'gender',     width: 10 },
    { header: 'Country',    key: 'country',    width: 14 },
    { header: 'City',       key: 'city',       width: 16 },
    { header: 'Occupation', key: 'occupation', width: 22 },
    { header: 'Question ID', key: 'question_id', width: 12 },
    { header: 'Question',    key: 'question',    width: 48 },
    { header: 'Answer',      key: 'answer',      width: 48 },
  ];
  raw.getRow(1).eachCell((c) => styleHeader(c));
  raw.views = [{ state: 'frozen', ySplit: 1 }];
  raw.autoFilter = { from: 'A1', to: 'I1' };

  const qById = {};
  for (const q of (mission.questions || [])) qById[q.id] = q;

  (responses || []).forEach((r) => {
    const p = r.persona_profile || {};
    const answerVal = typeof r.answer === 'object' ? JSON.stringify(r.answer) : String(r.answer ?? '');
    raw.addRow({
      persona_id:  r.persona_id,
      age:         p.age,
      gender:      p.gender,
      country:     p.country || p.country_code,
      city:        p.city,
      occupation:  p.occupation || p.role,
      question_id: r.question_id,
      question:    qById[r.question_id]?.text || '',
      answer:      answerVal,
    });
  });

  raw.eachRow({ includeEmpty: false }, (r, rowNumber) => {
    if (rowNumber === 1) return;
    if (rowNumber % 2 === 0) {
      r.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } }; });
    }
  });

  // ── SHEET 4: DEMOGRAPHIC BREAKDOWN ────────────────────────
  const demoSheet = wb.addWorksheet('Demographic breakdown', {
    properties: { tabColor: { argb: argb(BRAND.lime) } },
  });
  demoSheet.getColumn('A').width = 40;
  demoSheet.getColumn('B').width = 12;
  demoSheet.getColumn('C').width = 10;

  const ageBuckets   = { '18-24': 0, '25-34': 0, '35-44': 0, '45-54': 0, '55+': 0 };
  const countryDist  = {};
  const genderDist   = {};
  const occupDist    = {};

  const seenPersona = new Set();
  (responses || []).forEach((r) => {
    if (seenPersona.has(r.persona_id)) return;
    seenPersona.add(r.persona_id);
    const p = r.persona_profile || {};
    if (typeof p.age === 'number') {
      const b = p.age < 25 ? '18-24' : p.age < 35 ? '25-34' : p.age < 45 ? '35-44' : p.age < 55 ? '45-54' : '55+';
      ageBuckets[b]++;
    }
    if (p.country)    countryDist[p.country]   = (countryDist[p.country]   || 0) + 1;
    if (p.gender)     genderDist[p.gender]      = (genderDist[p.gender]     || 0) + 1;
    const occ = p.occupation || p.role;
    if (occ)          occupDist[occ]            = (occupDist[occ]           || 0) + 1;
  });

  const totalPersonas = seenPersona.size || 1;

  function addDemoTable(sheet, startRow, sectionTitle, entries) {
    sheet.getCell(`A${startRow}`).value = sectionTitle;
    sheet.getCell(`A${startRow}`).font  = { name: 'Calibri', size: 14, bold: true };
    startRow += 2;
    ['Category', 'Count', '%'].forEach((hh, i) => {
      const col = ['A', 'B', 'C'][i];
      const hCell = sheet.getCell(`${col}${startRow}`);
      hCell.value = hh;
      hCell.font  = { name: 'Calibri', size: 10, bold: true, color: { argb: argb(BRAND.lime) } };
      hCell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(BRAND.bg) } };
    });
    startRow++;
    entries.forEach(([label, count], idx) => {
      const p = Math.round((count / totalPersonas) * 100);
      sheet.getCell(`A${startRow}`).value = label;
      sheet.getCell(`B${startRow}`).value = count;
      sheet.getCell(`C${startRow}`).value = `${p}%`;
      if (idx % 2 === 0) {
        ['A', 'B', 'C'].forEach((col) => {
          sheet.getCell(`${col}${startRow}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } };
        });
      }
      startRow++;
    });
    return startRow + 2;
  }

  let dr = 1;
  dr = addDemoTable(demoSheet, dr, 'Age Distribution', Object.entries(ageBuckets));
  dr = addDemoTable(demoSheet, dr, 'Country Distribution', Object.entries(countryDist).sort((a, b) => b[1] - a[1]));
  dr = addDemoTable(demoSheet, dr, 'Gender Distribution', Object.entries(genderDist).sort((a, b) => b[1] - a[1]));
  const occEntries = Object.entries(occupDist).sort((a, b) => b[1] - a[1]);
  const totalOccCount = occEntries.reduce((s, [, v]) => s + v, 0);
  const occLabel = (totalOccCount >= 10 && occEntries.length > 10)
    ? 'Top 10 Occupations'
    : `Occupation distribution (n=${totalOccCount})`;
  addDemoTable(demoSheet, dr, occLabel, occEntries.slice(0, 10));

  // ── SHEET 5: DATA QUALITY NOTES (canonical, cleaned, one-per-question) ──
  if (model.dataQualityNotes.length > 0) {
    const dq = wb.addWorksheet('Data quality notes', {
      views: [{ state: 'frozen', ySplit: 1 }],
      properties: { tabColor: { argb: argb(BRAND.orange || '#fb923c') } },
    });
    dq.columns = [
      { header: 'Question', key: 'q', width: 12 },
      { header: 'Note',     key: 'note', width: 100 },
    ];
    dq.getRow(1).eachCell((c) => styleHeader(c));
    model.dataQualityNotes.forEach((n) => {
      dq.addRow({ q: `Q${n.question_number}`, note: n.note });
    });
  }

  // ── Methodology disclaimer as a trailing note on the Report sheet ──
  if (model.disclaimer) {
    row += 2;
    rep.getCell(`A${row}`).value = 'METHODOLOGY';
    rep.getCell(`A${row}`).font = { name: 'Calibri', size: 11, bold: true, color: { argb: argb(BRAND.lime) } };
    row += 1;
    rep.mergeCells(`A${row}:F${row + 3}`);
    const dis = rep.getCell(`A${row}`);
    dis.value = model.disclaimer;
    dis.font = { name: 'Calibri', size: 10, color: { argb: argb(BRAND.text3) }, italic: true };
    dis.alignment = { vertical: 'top', wrapText: true };
  }

  // ── SHEET: PERSONAS (§5 — who responded, n-gated) ──
  if (Array.isArray(model.personas) && model.personas.length > 0) {
    const ps = wb.addWorksheet('Personas', { views: [{ showGridLines: false }] });
    ps.columns = [{ width: 28 }, { width: 26 }, { width: 14 }, { width: 60 }];
    const ph = ps.getRow(1);
    ['Persona', 'Role', 'Share', 'Description'].forEach((h, i) => { ph.getCell(i + 1).value = h; styleHeader(ph.getCell(i + 1)); });
    ps.views = [{ state: 'frozen', ySplit: 1 }];
    model.personas.forEach((p, i) => {
      const r = ps.getRow(i + 2);
      r.getCell(1).value = p.name; r.getCell(1).font = { name: 'Calibri', size: 11, bold: true };
      r.getCell(2).value = p.role || '';
      r.getCell(3).value = p.share != null ? String(p.share) : '';
      r.getCell(4).value = p.description || '';
      r.getCell(4).alignment = { wrapText: true, vertical: 'top' };
      if (i % 2 === 0) [1, 2, 3, 4].forEach((c) => { r.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } }; });
    });
  }

  // Stream to response
  const fname = `vett-report-${(model.header.title || mission.id).toString().slice(0, 40).replace(/[^a-z0-9]+/gi, '-')}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  return wb.xlsx.write(res).then(() => res.end());
}

module.exports = { buildXLSX };
