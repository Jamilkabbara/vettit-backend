/**
 * VETT — Excel export using exceljs.
 * Five sheets:
 *   1. Cover                — title, brief, meta, executive summary
 *   2. Raw responses        — every persona/question row from mission_responses
 *   3. Summary              — per-question aggregated distribution / averages / verbatims
 *   4. Insights             — narrative findings + recommended next actions from AI
 *   5. Demographic breakdown — age / country / gender / occupation tables
 *
 * Dark-theme styling isn't truly visual in spreadsheets, but we adopt the
 * VETT palette for headers and banding so the file feels on-brand.
 */

const ExcelJS = require('exceljs');
const { BRAND } = require('./shared');
const { buildIntegrityWarnings } = require('./integrity');

// exceljs uses ARGB with leading alpha FF
const argb = (c) => 'FF' + (c || '').replace('#', '').toUpperCase();

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

function buildXLSX(pack, res) {
  const { mission, responses, insights, aggregatedByQuestion } = pack;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'VETT';
  wb.lastModifiedBy = 'VETT';
  wb.created = new Date();
  wb.title = mission.title || 'VETT Research Report';

  // ── SHEET 1: COVER ─────────────────────────────────────────
  const cover = wb.addWorksheet('Cover', {
    views: [{ showGridLines: false }],
    properties: { tabColor: { argb: argb(BRAND.lime) } },
  });
  cover.columns = [
    { width: 28 }, { width: 28 }, { width: 28 }, { width: 28 },
  ];

  cover.mergeCells('A1:D2');
  const title = cover.getCell('A1');
  title.value = 'VETT';
  title.font = { name: 'Calibri', size: 36, bold: true, color: { argb: argb(BRAND.lime) } };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(BRAND.bg) } };
  title.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

  cover.mergeCells('A3:D3');
  const sub = cover.getCell('A3');
  sub.value = 'AI-POWERED MARKET RESEARCH';
  sub.font = { name: 'Calibri', size: 10, bold: true, color: { argb: argb(BRAND.text2) } };
  sub.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(BRAND.bg) } };
  sub.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

  cover.mergeCells('A5:D6');
  const titleCell = cover.getCell('A5');
  titleCell.value = mission.title || 'Research Report';
  titleCell.font = { name: 'Calibri', size: 20, bold: true };
  titleCell.alignment = { vertical: 'middle', wrapText: true };

  cover.mergeCells('A7:D9');
  const briefCell = cover.getCell('A7');
  briefCell.value = mission.brief || mission.mission_statement || '';
  briefCell.font = { name: 'Calibri', size: 11, color: { argb: argb(BRAND.text3) } };
  briefCell.alignment = { vertical: 'top', wrapText: true };

  // Meta strip
  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const meta = [
    ['Respondents', String(mission.respondent_count || '—')],
    ['Completed at', mission.completed_at ? new Date(mission.completed_at).toLocaleString() : '—'],
    ['Report date', now],
    ['Mission ID', String(mission.id || '—')],
    ['Goal', mission.goal_type || '—'],
  ];
  let metaRow = 11;
  meta.forEach(([k, v]) => {
    const a = cover.getCell(`A${metaRow}`); a.value = k;
    a.font = { name: 'Calibri', size: 10, bold: true, color: { argb: argb(BRAND.text2) } };
    const b = cover.getCell(`B${metaRow}`); b.value = v;
    b.font = { name: 'Calibri', size: 10 };
    metaRow++;
  });

  // Executive summary
  metaRow += 2;
  const esHead = cover.getCell(`A${metaRow}`);
  esHead.value = 'EXECUTIVE SUMMARY';
  esHead.font = { name: 'Calibri', size: 10, bold: true, color: { argb: argb(BRAND.lime) } };
  metaRow++;
  cover.mergeCells(`A${metaRow}:D${metaRow + 4}`);
  const esBody = cover.getCell(`A${metaRow}`);
  esBody.value = insights.executive_summary || 'Executive summary unavailable.';
  esBody.font = { name: 'Calibri', size: 11 };
  esBody.alignment = { vertical: 'top', wrapText: true };

  // ── SHEET 2: RAW ───────────────────────────────────────────
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

  // Banding
  raw.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    if (rowNumber % 2 === 0) {
      row.eachCell((c) => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F9FC' } };
      });
    }
  });

  // ── SHEET 3: SUMMARY ───────────────────────────────────────
  const summary = wb.addWorksheet('Summary', {
    properties: { tabColor: { argb: argb(BRAND.lime) } },
  });
  summary.columns = [
    { header: 'Question', key: 'question', width: 48 },
    { header: 'Type',     key: 'type',     width: 10 },
    { header: 'n',        key: 'n',        width: 8  },
    { header: 'Metric',   key: 'metric',   width: 24 },
    { header: 'Value',    key: 'value',    width: 14 },
    { header: 'Share',    key: 'share',    width: 10 },
  ];
  summary.getRow(1).eachCell((c) => styleHeader(c));
  summary.views = [{ state: 'frozen', ySplit: 1 }];

  (mission.questions || []).forEach((q) => {
    const a = aggregatedByQuestion[q.id] || {};
    if (q.type === 'rating') {
      summary.addRow({ question: q.text, type: q.type, n: a.n || 0, metric: 'Average (1–5)', value: a.average || 0, share: '' });
      const dist = a.distribution || {};
      const total = Object.values(dist).reduce((s, v) => s + v, 0) || 1;
      for (let r = 5; r >= 1; r--) {
        const c = dist[r] || 0;
        summary.addRow({ question: '', type: '', n: '', metric: `★ ${r}`, value: c, share: `${Math.round((c/total)*100)}%` });
      }
    } else if (q.type === 'text') {
      summary.addRow({ question: q.text, type: q.type, n: a.n || 0, metric: 'Verbatims (sample)', value: '', share: '' });
      // Bug 7: no String.slice — full verbatim text in XLSX
      (a.verbatims || []).slice(0, 10).forEach((v) => {
        summary.addRow({ question: '', type: '', n: '', metric: String(v), value: '', share: '' });
      });
    } else if (q.type === 'multi') {
      // Bug 3: percentage = selections / n_respondents (not / total_clicks)
      const dist = a.distribution || {};
      const nRespondents = a.n_respondents || a.n || 1;
      const entries = Object.entries(dist).sort((x, y) => y[1] - x[1]);
      summary.addRow({ question: q.text, type: q.type, n: nRespondents, metric: 'Distribution (multi-select)', value: '', share: '' });
      entries.forEach(([opt, count]) => {
        summary.addRow({
          question: '', type: '', n: '',
          metric: String(opt),  // Bug 7: no slice
          value: count,
          share: `${Math.round((count / nRespondents) * 100)}%`,
        });
      });
    } else {
      const dist = a.distribution || {};
      const entries = Object.entries(dist).sort((x, y) => y[1] - x[1]);
      const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
      summary.addRow({ question: q.text, type: q.type, n: a.n || 0, metric: 'Distribution', value: '', share: '' });
      entries.forEach(([opt, count]) => {
        summary.addRow({
          question: '', type: '', n: '',
          metric: String(opt),  // Bug 7: no slice
          value: count,
          share: `${Math.round((count/total)*100)}%`,
        });
      });
    }
    // spacer row
    summary.addRow({});
  });

  // ── SHEET 4: INSIGHTS ──────────────────────────────────────
  const insightsSheet = wb.addWorksheet('Insights', {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { tabColor: { argb: argb(BRAND.lime) } },
  });
  insightsSheet.getColumn('A').width = 100;
  insightsSheet.getColumn('B').width = 20;
  insightsSheet.getColumn('C').width = 20;
  insightsSheet.getColumn('D').width = 20;

  // Title row
  insightsSheet.mergeCells('A1:D1');
  const insTitle = insightsSheet.getCell('A1');
  // Pass 25 Phase 0.1 Minor 3 — title only mentions Key Findings if we have any
  insTitle.value = (Array.isArray(insights?.key_findings) && insights.key_findings.length)
    ? 'Executive Summary & Key Findings'
    : 'Executive Summary';
  insTitle.font  = { name: 'Calibri', size: 16, bold: true, color: { argb: argb(BRAND.lime) } };
  insTitle.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(BRAND.bg) } };
  insTitle.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  insightsSheet.getRow(1).height = 32;

  const ai = insights || {};
  const execSummary = ai.executive_summary || ai.summary || 'Insights not available for this mission.';

  // Executive summary block
  insightsSheet.mergeCells('A3:D7');
  const esCell = insightsSheet.getCell('A3');
  esCell.value = execSummary;
  esCell.font = { name: 'Calibri', size: 11 };
  esCell.alignment = { wrapText: true, vertical: 'top' };
  insightsSheet.getRow(3).height = 80;

  let insRow = 9;

  // Key Findings
  const findings = ai.key_findings || ai.findings || [];
  if (findings.length > 0) {
    insightsSheet.mergeCells(`A${insRow}:D${insRow}`);
    insightsSheet.getCell(`A${insRow}`).value = 'Key Findings';
    insightsSheet.getCell(`A${insRow}`).font = { name: 'Calibri', size: 14, bold: true };
    insRow += 2;

    findings.forEach((f) => {
      const titleText = typeof f === 'string' ? f : (f.title || f.headline || '');
      const bodyText  = typeof f === 'string' ? '' : (f.description || f.body || '');

      if (titleText) {
        insightsSheet.mergeCells(`A${insRow}:D${insRow}`);
        const tCell = insightsSheet.getCell(`A${insRow}`);
        tCell.value = `• ${titleText}`;
        tCell.font  = { name: 'Calibri', size: 11, bold: true };
        insRow++;
      }
      if (bodyText) {
        insightsSheet.mergeCells(`A${insRow}:D${insRow}`);
        const bCell = insightsSheet.getCell(`A${insRow}`);
        bCell.value = bodyText;
        bCell.font  = { name: 'Calibri', size: 10, color: { argb: argb(BRAND.text3) } };
        bCell.alignment = { wrapText: true };
        insightsSheet.getRow(insRow).height = 40;
        insRow += 2;
      }
    });
  }

  // Recommended Next Actions
  const actions = ai.recommendations || ai.next_actions || [];
  if (actions.length > 0) {
    insRow += 1;
    insightsSheet.mergeCells(`A${insRow}:D${insRow}`);
    insightsSheet.getCell(`A${insRow}`).value = 'Recommended Next Actions';
    insightsSheet.getCell(`A${insRow}`).font = { name: 'Calibri', size: 14, bold: true };
    insRow += 2;

    actions.forEach((a, i) => {
      const text = typeof a === 'string' ? a : (a.text || a.action || JSON.stringify(a));
      insightsSheet.mergeCells(`A${insRow}:D${insRow}`);
      const aCell = insightsSheet.getCell(`A${insRow}`);
      aCell.value = `${i + 1}. ${text}`;
      aCell.font  = { name: 'Calibri', size: 11 };
      aCell.alignment = { wrapText: true };
      insRow++;
    });
  }

  // ── SHEET 5: DEMOGRAPHIC BREAKDOWN ────────────────────────
  const demoSheet = wb.addWorksheet('Demographic breakdown', {
    properties: { tabColor: { argb: argb(BRAND.lime) } },
  });
  demoSheet.getColumn('A').width = 40;
  demoSheet.getColumn('B').width = 12;
  demoSheet.getColumn('C').width = 10;

  // Build distributions from responses
  const ageBuckets   = { '18-24': 0, '25-34': 0, '35-44': 0, '45-54': 0, '55+': 0 };
  const countryDist  = {};
  const genderDist   = {};
  const occupDist    = {};

  // Deduplicate by persona_id — persona appears once per question
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
    // Section header
    sheet.getCell(`A${startRow}`).value = sectionTitle;
    sheet.getCell(`A${startRow}`).font  = { name: 'Calibri', size: 14, bold: true };
    startRow += 2;
    // Column headers
    ['Category', 'Count', '%'].forEach((h, i) => {
      const col = ['A','B','C'][i];
      const hCell = sheet.getCell(`${col}${startRow}`);
      hCell.value = h;
      hCell.font  = { name: 'Calibri', size: 10, bold: true, color: { argb: argb(BRAND.lime) } };
      hCell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(BRAND.bg) } };
    });
    startRow++;
    entries.forEach(([label, count], idx) => {
      const pct = Math.round((count / totalPersonas) * 100);
      sheet.getCell(`A${startRow}`).value = label;
      sheet.getCell(`B${startRow}`).value = count;
      sheet.getCell(`C${startRow}`).value = `${pct}%`;
      if (idx % 2 === 0) {
        ['A','B','C'].forEach(col => {
          sheet.getCell(`${col}${startRow}`).fill = {
            type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F9FC' },
          };
        });
      }
      startRow++;
    });
    return startRow + 2; // gap before next table
  }

  let dr = 1;
  dr = addDemoTable(demoSheet, dr, 'Age Distribution',
    Object.entries(ageBuckets));
  dr = addDemoTable(demoSheet, dr, 'Country Distribution',
    Object.entries(countryDist).sort((a, b) => b[1] - a[1]));
  dr = addDemoTable(demoSheet, dr, 'Gender Distribution',
    Object.entries(genderDist).sort((a, b) => b[1] - a[1]));
  // Pass 25 Phase 0.1 Minor 2 — drop the "Top 10" framing for small samples
  // where every value is unique; ranking is meaningless. Keep "Top 10" only
  // when n >= 10 AND there's actual ranking signal (more rows than slots).
  const occEntries = Object.entries(occupDist).sort((a, b) => b[1] - a[1]);
  const totalOccCount = occEntries.reduce((s, [, v]) => s + v, 0);
  const occLabel = (totalOccCount >= 10 && occEntries.length > 10)
    ? 'Top 10 Occupations'
    : `Occupation distribution (n=${totalOccCount})`;
  addDemoTable(demoSheet, dr, occLabel, occEntries.slice(0, 10));

  // ── SHEET 6: DATA INTEGRITY (Pass 25 Phase 0.1 Bug H + A) ─
  // Hidden sheet — surfaces schema drift and option overlap warnings without
  // cluttering the primary tab strip. Users find via "View hidden sheets".
  const integrityWarnings = buildIntegrityWarnings(mission, aggregatedByQuestion);
  if (integrityWarnings.length > 0) {
    const intSheet = wb.addWorksheet('Data integrity', {
      state: 'hidden',
      properties: { tabColor: { argb: argb(BRAND.orange || '#fb923c') } },
    });
    intSheet.columns = [
      { header: 'Type', width: 32 },
      { header: 'Question', width: 16 },
      { header: 'Detail A', width: 60 },
      { header: 'Detail B', width: 60 },
    ];
    const headerRow = intSheet.getRow(1);
    headerRow.eachCell((c) => styleHeader(c));
    integrityWarnings.forEach((w) => {
      const row = w.type === 'unknown_distribution_key'
        ? [w.type, w.question_id, `drifted keys: ${w.drifted_keys.join(' | ')}`, `schema options: ${w.schema_options.join(' | ')}`]
        : [w.type, w.question_id, `option A: ${w.option_a}`, `option B: ${w.option_b} (ratio ${w.overlap_ratio})`];
      intSheet.addRow(row);
    });
  }

  // Stream to response
  const fname = `vett-report-${(mission.title || mission.id).toString().slice(0, 40).replace(/[^a-z0-9]+/gi, '-')}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  return wb.xlsx.write(res).then(() => res.end());
}

module.exports = { buildXLSX };
