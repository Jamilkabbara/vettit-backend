/**
 * VETT — PowerPoint export using pptxgenjs.
 *
 * Pass 48 Phase 3 — REBUILT on the CanonicalReport. The deck renders the
 * SAME report the web results page renders (buildCanonicalReport →
 * buildRenderModel), in the uniform order shared by every export format:
 *
 *   1. Cover                 (VETT wordmark + title + brief + sample meta)
 *   2. Executive summary     (canonical exec_summary — no "fuller narrative")
 *   3. Headline metrics      (the methodology's key computed numbers)
 *   4. Centerpiece           (brand-lift exposed-vs-control funnel table —
 *                             FULL funnel, every stage, not one numeric stage)
 *   5. Key findings          (insights.kpis)
 *   6..N. THE FULL SURVEY    (one slide per question, rendered by its
 *                             renderer with the CORRECT scale — 0-10 NPS is
 *                             a 0-10 bar chart, 1-7 CES is 1-7, attribute
 *                             battery is a per-attribute table, max_diff is
 *                             best/worst, verbatims are quotes). This kills
 *                             the export "7/5" / "0/5" bug.
 *   N+1. Data quality notes  (canonical cleaned notes — one per question)
 *   N+2. Methodology         (disclaimer)
 *
 * The OLD per-question 5-star rendering and the spammy integrity-warning
 * slide are GONE — the canonical report replaces both.
 *
 * Dark-theme slide deck mirroring the web aesthetic: near-black background,
 * lime accents, manually-drawn bar shapes (pptxgenjs's native addChart()
 * renders empty in Keynote / some Google Slides versions).
 */

const PptxGenJS = require('pptxgenjs');
const { BRAND } = require('./shared');
const { buildCanonicalReport } = require('../report/buildReport');
const { buildRenderModel } = require('../report/reportRenderModel');

// §5 — brand typography. pptxgenjs can't embed font binaries, so these are
// face NAMES: a viewer with the brand fonts installed renders them, otherwise
// PowerPoint falls back to a clean sans. Brand COLORS carry identity regardless.
const FONT = 'Inter';                  // body / data / labels
const FONT_DISPLAY = 'Manrope';        // display / big numerals
const FONT_SERIF = 'Manrope'; // finding voice — reverted from Instrument Serif (read thin on dark); heavy Manrope instead

// pptxgenjs uses hex codes without the leading '#'
const hex = (c) => (c || '').replace('#', '');

function addDarkBackground(slide) {
  slide.background = { color: hex(BRAND.bg) };
  slide.addShape('rect', {
    x: 0, y: 0, w: '100%', h: 0.06,
    fill: { color: hex(BRAND.lime) }, line: { color: hex(BRAND.lime) },
  });
  slide.addText('VETT  ·  vettit.ai', {
    x: 0.5, y: 7.15, w: 12.3, h: 0.3,
    fontSize: 9, color: hex(BRAND.text3), fontFace: FONT, align: 'center',
  });
}

function addSectionHeader(slide, eyebrow, title) {
  slide.addText(eyebrow, {
    x: 0.5, y: 0.35, w: 12.3, h: 0.3,
    fontSize: 10, bold: true, color: hex(BRAND.lime), fontFace: FONT, charSpacing: 2,
  });
  slide.addText(title, {
    x: 0.5, y: 0.65, w: 12.3, h: 0.7,
    fontSize: 24, bold: true, color: 'FFFFFF', fontFace: FONT,
    shrinkText: true, autoFit: true,
  });
  slide.addShape('rect', {
    x: 0.5, y: 1.40, w: 12.3, h: 0.03,
    fill: { color: hex(BRAND.lime) }, line: { color: hex(BRAND.lime) },
  });
}

// Manually-drawn horizontal bar chart. items: [{ label, value(0-100), count? }]
function drawBars(slide, items, opts) {
  const { x, y, w, h, title, subtitle, showCount } = opts;
  let cursorY = y;

  if (title) {
    slide.addText(title, {
      x, y: cursorY, w, h: 0.3,
      fontSize: 12, color: hex(BRAND.text1), fontFace: FONT, bold: true,
    });
    cursorY += 0.32;
  }
  if (subtitle) {
    slide.addText(subtitle, {
      x, y: cursorY, w, h: 0.25,
      fontSize: 10, color: hex(BRAND.text2), fontFace: FONT,
    });
    cursorY += 0.28;
  }

  if (!items.length) return;
  const remaining = h - (cursorY - y);
  const rowGap = 0.08;
  const rowH = Math.min(0.45, Math.max(0.2, (remaining - rowGap * (items.length - 1)) / items.length));
  const labelW = Math.min(2.7, w * 0.4);
  const trackX = x + labelW + 0.15;
  const metaW = 0.95;
  const trackW = w - labelW - 0.15 - metaW - 0.1;
  const barTrackH = Math.min(0.18, rowH * 0.45);

  items.forEach((it, i) => {
    const rowY = cursorY + i * (rowH + rowGap);
    const barCenterY = rowY + (rowH - barTrackH) / 2;
    const p = Math.max(0, Math.min(100, Number(it.value) || 0));
    slide.addText(String(it.label || ''), {
      x, y: rowY, w: labelW, h: rowH,
      fontSize: 10, color: hex(BRAND.text1), fontFace: FONT, valign: 'middle',
      shrinkText: true, autoFit: true,
    });
    slide.addShape('rect', {
      x: trackX, y: barCenterY, w: trackW, h: barTrackH,
      fill: { color: hex(BRAND.bg3) }, line: { type: 'none' },
    });
    if (p > 0) {
      slide.addShape('rect', {
        x: trackX, y: barCenterY, w: trackW * (p / 100), h: barTrackH,
        fill: { color: hex(BRAND.lime) }, line: { type: 'none' },
      });
    }
    const meta = showCount && it.count != null ? `${it.count} · ${p}%` : `${p}%`;
    slide.addText(meta, {
      x: trackX + trackW + 0.05, y: rowY, w: metaW, h: rowH,
      fontSize: 10, color: hex(BRAND.text2), fontFace: FONT, valign: 'middle', align: 'left',
    });
  });
}

function statCard(slide, x, y, w, h, label, value, trendColor = BRAND.lime) {
  slide.addShape('roundRect', {
    x, y, w, h, rectRadius: 0.1,
    fill: { color: hex(BRAND.bg2) }, line: { color: hex(BRAND.border) },
  });
  slide.addText(String(label || '').toUpperCase(), {
    x: x + 0.15, y: y + 0.1, w: w - 0.3, h: 0.5,
    fontSize: 9, color: hex(BRAND.text3), fontFace: FONT, charSpacing: 1, valign: 'top',
    shrinkText: true,
  });
  slide.addText(String(value || '—'), {
    x: x + 0.15, y: y + 0.6, w: w - 0.3, h: h - 0.7,
    fontSize: 24, bold: true, color: hex(trendColor), fontFace: FONT,
    shrinkText: true, autoFit: true,
  });
}

/** Clean responses the same way results.js /report does (mirror the web). */
function cleanResponses(responses) {
  const all = responses || [];
  const clean = all.filter((r) =>
    r && r.screened_out !== true && !(r.persona_profile && r.persona_profile.screened_out === true));
  return clean.length > 0 ? clean : all;
}

// Render one survey question's body onto its slide (left column; the slide
// header already carries the eyebrow + question text).
function renderSurveyBody(slide, q) {
  const body = q.body;
  const FRAME = { x: 0.5, y: 1.65, w: 12.3, h: 5.2 };

  if (body.kind === 'scale') {
    drawBars(slide, body.bars.map((b) => ({ label: b.label, value: b.pct, count: b.count })), {
      ...FRAME, title: body.headline, showCount: true,
    });
    return;
  }
  if (body.kind === 'matrix') {
    drawBars(slide, body.rows.map((r) => ({ label: r.label, value: r.pct, count: r.average })), {
      ...FRAME, title: `Per-attribute averages (out of 5, n=${body.n})`, showCount: true,
    });
    return;
  }
  if (body.kind === 'maxdiff') {
    if (body.empty) {
      slide.addText(body.empty_message, { ...FRAME, fontSize: 13, italic: true, color: hex(BRAND.text3), fontFace: FONT });
      return;
    }
    const rows = [[
      { text: 'Feature', options: { bold: true, color: hex(BRAND.text3) } },
      { text: 'Best', options: { bold: true, color: hex(BRAND.text3), align: 'right' } },
      { text: 'Worst', options: { bold: true, color: hex(BRAND.text3), align: 'right' } },
    ]];
    body.rows.forEach((r) => rows.push([
      { text: String(r.label), options: { color: hex(BRAND.text1) } },
      { text: String(r.best), options: { color: hex(BRAND.lime), align: 'right' } },
      { text: String(r.worst), options: { color: hex(BRAND.text2), align: 'right' } },
    ]));
    slide.addTable(rows, {
      ...FRAME, fontSize: 11, fontFace: FONT, colW: [8.3, 2.0, 2.0],
      border: { type: 'solid', color: hex(BRAND.border), pt: 0.5 },
    });
    return;
  }
  if (body.kind === 'verbatims') {
    if (body.empty) {
      slide.addText(body.empty_message, { ...FRAME, fontSize: 13, italic: true, color: hex(BRAND.text3), fontFace: FONT });
      return;
    }
    // P2-1 — open-end themes render as a bar chart (the open-end's visual),
    // sentiment in the label; falls back to verbatims when no themes.
    if (body.has_themes) {
      drawBars(slide, body.themes.map((t) => ({ label: `${t.label} · ${t.sentiment}`, value: t.pct, count: t.count })), {
        ...FRAME, title: `Themes across ${body.n} open-ended responses`, showCount: true,
      });
      return;
    }
    const items = [];
    body.items.slice(0, 10).forEach((v, i) => {
      if (i > 0) items.push({ text: '', options: { breakLine: true } });
      items.push({ text: `“${String(v)}”`, options: { italic: true, color: hex(BRAND.text2), fontSize: 12, bullet: { code: '25CF' }, paraSpaceAfter: 6 } });
    });
    slide.addText(items, { ...FRAME, fontFace: FONT, valign: 'top' });
    return;
  }
  // bars (choice / multi / endorsement)
  if (body.empty) {
    slide.addText(body.empty_message, { ...FRAME, fontSize: 13, italic: true, color: hex(BRAND.text3), fontFace: FONT });
    return;
  }
  drawBars(slide, body.bars.map((b) => ({ label: b.label, value: b.pct, count: b.count })), {
    ...FRAME, subtitle: body.note || undefined, showCount: true,
  });
}

function buildPPTX(pack, res) {
  const { mission } = pack;

  // STEP 1 — canonical report once, then the shared render model.
  const report = buildCanonicalReport(mission, mission.analysis || null, cleanResponses(pack.responses));
  const model = buildRenderModel(report);

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';     // 13.333 × 7.5 in
  pptx.title = model.header.title || 'VETT Research Report';
  pptx.company = 'VETT';
  pptx.subject = model.header.brief || '';

  // ── COVER ─────────────────────────────────────────────────
  const cover = pptx.addSlide();
  cover.background = { color: hex(BRAND.bg) };
  cover.addShape('rect', { x: 0, y: 0, w: '100%', h: 0.1, fill: { color: hex(BRAND.lime) }, line: { color: hex(BRAND.lime) } });
  cover.addText('VETT', { x: 0.7, y: 0.55, w: 6, h: 1.0, fontSize: 60, bold: true, color: hex(BRAND.lime), fontFace: FONT_DISPLAY });
  cover.addText('AI-POWERED MARKET RESEARCH', { x: 0.7, y: 1.65, w: 11, h: 0.4, fontSize: 12, color: hex(BRAND.text2), fontFace: FONT, charSpacing: 2 });
  // §5 — the finding leads the cover, in the serif "finding voice".
  cover.addText(model.finding || model.header.title, { x: 0.7, y: 2.35, w: 12, h: 2.5, fontSize: 32, bold: true, color: 'FFFFFF', fontFace: FONT_SERIF, valign: 'top', shrinkText: true });
  if (model.finding && model.header.title) {
    cover.addText(model.header.title, { x: 0.7, y: 5.05, w: 12, h: 0.6, fontSize: 13, color: hex(BRAND.text3), fontFace: FONT, valign: 'top', shrinkText: true });
  }
  // Sample / meta strip
  const metaRuns = [];
  model.header.metaRows.forEach(([k, v]) => {
    metaRuns.push({ text: `${k}: `, options: { color: hex(BRAND.text3) } });
    metaRuns.push({ text: `${v}    `, options: { color: 'FFFFFF', bold: true } });
  });
  if (metaRuns.length) cover.addText(metaRuns, { x: 0.7, y: 6.2, w: 12, h: 0.8, fontSize: 10, fontFace: FONT, valign: 'top' });

  // ── EXECUTIVE SUMMARY ─────────────────────────────────────
  const summary = pptx.addSlide();
  addDarkBackground(summary);
  addSectionHeader(summary, '01 · VETT SYNTHESIS', 'What the research says');
  summary.addText(model.synthesis || model.execSummary || 'Synthesis not available for this mission.', {
    x: 0.5, y: 1.65, w: 12.3, h: 4.7,
    fontSize: 16, color: hex(BRAND.text1), fontFace: FONT_SERIF, paraSpaceAfter: 8, valign: 'top', autoFit: true,
  });
  // §2.4 — directional banner when the sample can't support an authoritative read.
  if (model.gate && model.gate.posture === 'directional' && model.gate.note) {
    summary.addText(
      [
        { text: 'DIRECTIONAL   ', options: { bold: true, color: hex(BRAND.amber) } },
        { text: `${model.gate.note}${model.gate.n ? ` · n=${model.gate.n}` : ''}`, options: { color: hex(BRAND.text2) } },
      ],
      { x: 0.5, y: 6.55, w: 12.3, h: 0.75, fontSize: 11, fontFace: FONT, valign: 'top', line: { color: hex(BRAND.amber), width: 0.75 }, fill: { color: hex(BRAND.bg2) }, margin: 6 },
    );
  }

  // ── HEADLINE METRICS ──────────────────────────────────────
  if (model.headline) {
    const PER_SLIDE = 12;
    const pageCount = Math.ceil(model.headline.all.length / PER_SLIDE);
    for (let pageIdx = 0; pageIdx < pageCount; pageIdx += 1) {
      const slide = pptx.addSlide();
      addDarkBackground(slide);
      addSectionHeader(slide, '02 · HEADLINE METRICS', pageCount > 1 ? `The numbers that matter (${pageIdx + 1}/${pageCount})` : 'The numbers that matter');
      const slotRows = model.headline.all.slice(pageIdx * PER_SLIDE, (pageIdx + 1) * PER_SLIDE);
      const items = [];
      slotRows.forEach((m, i) => {
        if (i > 0) items.push({ text: '', options: { breakLine: true } });
        items.push({ text: `${m.label}:  `, options: { fontSize: 13, color: hex(BRAND.text2), breakLine: false } });
        items.push({ text: String(m.value), options: { fontSize: 13, bold: true, color: hex(BRAND.lime), paraSpaceAfter: 8 } });
      });
      slide.addText(items, { x: 0.5, y: 1.65, w: 12.3, h: 5.3, fontFace: FONT, valign: 'top' });
    }
  }

  // ── CENTERPIECE (brand-lift exposed-vs-control funnel — FULL funnel) ──
  if (model.centerpiece) {
    const slide = pptx.addSlide();
    addDarkBackground(slide);
    addSectionHeader(slide, '03 · CENTERPIECE', model.centerpiece.title);
    const header = model.centerpiece.columns.map((c) => ({ text: c, options: { bold: true, color: hex(BRAND.text3), fill: { color: hex(BRAND.bg2) } } }));
    const rows = [header];
    model.centerpiece.rows.forEach((cells) => {
      rows.push(cells.map((v, ci) => ({
        text: String(v),
        options: { color: ci === 3 ? hex(BRAND.lime) : hex(BRAND.text1), align: ci === 0 ? 'left' : 'right' },
      })));
    });
    slide.addTable(rows, {
      x: 0.5, y: 1.65, w: 12.3, fontSize: 11, fontFace: FONT,
      border: { type: 'solid', color: hex(BRAND.border), pt: 0.5 }, valign: 'middle',
    });
  }

  // ── KEY FINDINGS ──────────────────────────────────────────
  if (model.keyFindings.length > 0) {
    const slide = pptx.addSlide();
    addDarkBackground(slide);
    addSectionHeader(slide, '04 · KEY FINDINGS', 'What stood out');
    // First 3 as stat cards when they carry values; otherwise as a bullet list.
    const withValues = model.keyFindings.filter((f) => f.value);
    if (withValues.length >= 1 && withValues.length <= 3 && withValues.length === model.keyFindings.length) {
      const cardW = 3.8; const cardH = 2.2;
      const totalW = withValues.length * cardW + (withValues.length - 1) * 0.3;
      const startX = (13.333 - totalW) / 2;
      withValues.forEach((f, i) => statCard(slide, startX + i * (cardW + 0.3), 2.3, cardW, cardH, f.title, f.value));
    } else {
      const items = [];
      model.keyFindings.forEach((f, i) => {
        if (i > 0) items.push({ text: '', options: { breakLine: true } });
        items.push({ text: f.value ? `${f.title}: ${f.value}` : f.title, options: { fontSize: 15, bold: true, color: 'FFFFFF', bullet: { code: '25CF' } } });
        if (f.body) {
          items.push({ text: '', options: { breakLine: true } });
          items.push({ text: f.body, options: { fontSize: 11, color: hex(BRAND.text2), paraSpaceAfter: 10 } });
        }
      });
      slide.addText(items, { x: 0.5, y: 1.65, w: 12.3, h: 5.3, fontFace: FONT, valign: 'top' });
    }
  }

  // ── RECOMMENDATIONS (B1 — grounded action list) ──
  if (Array.isArray(model.recommendations) && model.recommendations.length > 0) {
    const slide = pptx.addSlide();
    addDarkBackground(slide);
    addSectionHeader(slide, '· RECOMMENDATIONS', 'What to do next');
    const items = [];
    model.recommendations.forEach((r, i) => {
      if (i > 0) items.push({ text: '', options: { breakLine: true } });
      items.push({ text: r, options: { fontSize: 13, color: 'FFFFFF', bullet: { code: '25CF', indent: 18 }, paraSpaceAfter: 12 } });
    });
    slide.addText(items, { x: 0.5, y: 1.65, w: 12.3, h: 5.3, fontFace: FONT, valign: 'top' });
  }

  // ── PERSONAS (§5 — who responded, n-gated) ──
  if (Array.isArray(model.personas) && model.personas.length > 0) {
    const slide = pptx.addSlide();
    addDarkBackground(slide);
    addSectionHeader(slide, '· WHO RESPONDED', 'The personas behind the numbers');
    const items = [];
    model.personas.forEach((p, i) => {
      if (i > 0) items.push({ text: '', options: { breakLine: true } });
      const head = p.role ? `${p.name} · ${p.role}` : p.name;
      items.push({ text: head + (p.share ? `   (${p.share})` : ''), options: { fontSize: 14, bold: true, color: 'FFFFFF', bullet: { code: '25CF' } } });
      if (p.description) {
        items.push({ text: '', options: { breakLine: true } });
        items.push({ text: p.description, options: { fontSize: 11, color: hex(BRAND.text2), paraSpaceAfter: 10 } });
      }
    });
    slide.addText(items, { x: 0.5, y: 1.65, w: 12.3, h: 5.3, fontFace: FONT, valign: 'top' });
  }

  // ── THE FULL SURVEY (one slide per question, correct renderer) ──
  model.survey.forEach((q, qi) => {
    const slide = pptx.addSlide();
    addDarkBackground(slide);
    // §5 — insight LEADS: the plain-language read is the slide headline; the
    // question text rides in the eyebrow, the chart is the body.
    const tag = `${String(qi + 5).padStart(2, '0')} · Q${q.number} · ${q.renderer_label.toUpperCase()}${q.isScreening ? ' · SCREENER' : ''}`;
    const eyebrow = q.insight ? `${tag}  —  ${q.text}` : tag;
    addSectionHeader(slide, eyebrow, q.insight || q.text);
    renderSurveyBody(slide, q);
  });

  // ── DATA QUALITY NOTES (canonical cleaned notes) ──
  if (model.dataQualityNotes.length > 0) {
    const slide = pptx.addSlide();
    addDarkBackground(slide);
    addSectionHeader(slide, '· DATA QUALITY NOTES', 'Items worth a follow-up review');
    const items = [{
      text: 'A few items in this report may warrant follow-up. The findings above still reflect the data as recorded.',
      options: { fontSize: 11, color: hex(BRAND.text2), italic: true, paraSpaceAfter: 14 },
    }, { text: '', options: { breakLine: true } }];
    model.dataQualityNotes.forEach((n, i) => {
      if (i > 0) items.push({ text: '', options: { breakLine: true } });
      items.push({ text: `Q${n.question_number}: `, options: { fontSize: 13, bold: true, color: hex(BRAND.lime) } });
      items.push({ text: n.note, options: { fontSize: 12, color: hex(BRAND.text2), paraSpaceAfter: 8 } });
    });
    slide.addText(items, { x: 0.5, y: 1.6, w: 12.3, h: 5, fontFace: FONT, valign: 'top' });
  }

  // ── METHODOLOGY (disclaimer) ──
  if (model.disclaimer) {
    const slide = pptx.addSlide();
    addDarkBackground(slide);
    addSectionHeader(slide, '· METHODOLOGY', 'How to read this report');
    slide.addText(model.disclaimer, {
      x: 0.5, y: 1.65, w: 12.3, h: 5, fontSize: 13, color: hex(BRAND.text2), fontFace: FONT, valign: 'top', autoFit: true,
    });
  }

  // ── Stream to response ────────────────────────────────────
  const fname = `vett-report-${(model.header.title || mission.id).toString().slice(0, 40).replace(/[^a-z0-9]+/gi, '-')}.pptx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);

  return pptx.stream().then((buffer) => {
    res.end(Buffer.from(buffer));
  });
}

module.exports = { buildPPTX };
