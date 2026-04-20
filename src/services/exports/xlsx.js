/**
 * VETT — Excel export using exceljs.
 * Three sheets that mirror the HTML prototype:
 *   1. Cover    — title, brief, meta, executive summary
 *   2. Raw      — every persona/question row from mission_responses
 *   3. Summary  — per-question aggregated distribution / averages / verbatims
 *
 * Dark-theme styling isn't truly visual in spreadsheets, but we adopt the
 * VETT palette for headers and banding so the file feels on-brand.
 */

const ExcelJS = require('exceljs');
const { BRAND } = require('./shared');

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
      (a.verbatims || []).slice(0, 10).forEach((v) => {
        summary.addRow({ question: '', type: '', n: '', metric: String(v).slice(0, 250), value: '', share: '' });
      });
    } else {
      const dist = a.distribution || {};
      const entries = Object.entries(dist).sort((x, y) => y[1] - x[1]);
      const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
      summary.addRow({ question: q.text, type: q.type, n: a.n || 0, metric: 'Distribution', value: '', share: '' });
      entries.forEach(([opt, count]) => {
        summary.addRow({
          question: '', type: '', n: '',
          metric: String(opt).slice(0, 80),
          value: count,
          share: `${Math.round((count/total)*100)}%`,
        });
      });
    }
    // spacer row
    summary.addRow({});
  });

  // Stream to response
  const fname = `vett-report-${(mission.title || mission.id).toString().slice(0, 40).replace(/[^a-z0-9]+/gi, '-')}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  return wb.xlsx.write(res).then(() => res.end());
}

module.exports = { buildXLSX };
