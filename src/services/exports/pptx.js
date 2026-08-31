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

// ── Header title fit ─────────────────────────────────────────────────────────
// A long question title relied on <a:normAutofit/> to shrink into its fixed
// 0.70" / 24pt box. But normAutofit (written with no precomputed fontScale) is
// IGNORED by LibreOffice, Google Slides, Keynote, and every preview/thumbnail
// renderer — they draw the full 24pt, so the wrapped question overflowed the box
// and collided with the eyebrow above AND the divider/chart below. Fix: pick a
// font size deterministically so the wrapped title stays within a few lines, and
// size the header band to the REAL text height (see the survey loop) so the
// divider + chart always sit below it. valign:'top' keeps any residual overflow
// pointing down, never up into the eyebrow.
const TITLE_W = 12.3;                          // header text-box width (inches)
function titleLineHeight(fs) { return 1.2 * fs / 72; }   // inches
function estTitleLines(text, fs, w = TITLE_W) {
  const len = String(text || '').trim().length || 1;
  // Deliberately CONSERVATIVE advance (Inter bold real avg ≈ 0.54em): over-
  // estimating glyph width => fewer chars/line => the estimate is an UPPER bound
  // on the real wrap. That guarantees the reserved header band (sized from this
  // count) always contains the actual text, so the divider/chart never collide.
  const charW = 0.64 * fs / 72;
  const cpl = Math.max(1, Math.floor(w / charW));
  return Math.max(1, Math.ceil(len / cpl));
}
// Largest size in [min,max] whose wrapped title fits maxLines; else min.
function fitTitleFontSize(text, { max = 24, min = 15, maxLines = 3 } = {}) {
  for (let fs = max; fs > min; fs -= 1) {
    if (estTitleLines(text, fs) <= maxLines) return fs;
  }
  return min;
}

function addSectionHeader(slide, eyebrow, title, opts = {}) {
  slide.addText(eyebrow, {
    x: 0.5, y: 0.35, w: 12.3, h: 0.3,
    fontSize: 10, bold: true, color: hex(BRAND.lime), fontFace: FONT, charSpacing: 2,
  });
  const titleOpts = {
    x: 0.5, y: opts.titleY ?? 0.65, w: 12.3, h: opts.titleH ?? 0.7,
    fontSize: opts.titleFontSize ?? 24, bold: true, color: 'FFFFFF', fontFace: FONT,
    shrinkText: true, autoFit: true,
  };
  // Survey headers pass valign:'top' so a multi-line question can only grow
  // downward (into its reserved band), never up into the eyebrow. Section slides
  // omit it, keeping their previous vertical alignment byte-for-byte.
  if (opts.titleValign) titleOpts.valign = opts.titleValign;
  slide.addText(title, titleOpts);
  slide.addShape('rect', {
    x: 0.5, y: opts.dividerY ?? 1.40, w: 12.3, h: 0.03,
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
  slide.addText(String(value || 'n/a'), {
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
function renderSurveyBody(slide, q, frameOverride) {
  const body = q.body;
  const FRAME = frameOverride || { x: 0.5, y: 1.65, w: 12.3, h: 5.2 };

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
  // Deck cap — drawBars floors row height, so too many bars overflow the frame
  // and collide with the narration box. Show the top 12; the PDF/XLSX keep every
  // row. (Bars arrive ordered by share.)
  const allBars = Array.isArray(body.bars) ? body.bars : [];
  const MAX_BARS = 12;
  const bars = allBars.slice(0, MAX_BARS);
  const capNote = allBars.length > MAX_BARS
    ? `${body.note ? `${body.note} · ` : ''}Top ${MAX_BARS} of ${allBars.length} shown`
    : (body.note || undefined);
  drawBars(slide, bars.map((b) => ({ label: b.label, value: b.pct, count: b.count })), {
    ...FRAME, subtitle: capNote, showCount: true,
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
  // §2.4 — directional banner when the sample can't support an authoritative read.
  const hasGateBand = Boolean(model.gate && model.gate.posture === 'directional' && model.gate.note);
  // The banner used to sit at 6.55 with h 0.75, i.e. bottom 7.30 — 0.15" INTO the
  // slide footer (y 7.15 to 7.45), colliding with it on every directional deck.
  // It now ends at 7.00, and the synthesis box above shrinks ONLY when the banner
  // is present so the two never touch. Without a banner the synthesis keeps its
  // original 4.7 height, so those slides are unchanged.
  summary.addText(model.synthesis || model.execSummary || 'Synthesis not available for this mission.', {
    x: 0.5, y: 1.65, w: 12.3, h: hasGateBand ? 4.45 : 4.7,
    fontSize: 16, color: hex(BRAND.text1), fontFace: FONT_SERIF, paraSpaceAfter: 8, valign: 'top', autoFit: true,
  });
  if (hasGateBand) {
    summary.addText(
      [
        { text: 'DIRECTIONAL   ', options: { bold: true, color: hex(BRAND.amber) } },
        { text: `${model.gate.note}${model.gate.n ? ` · n=${model.gate.n}` : ''}`, options: { color: hex(BRAND.text2) } },
      ],
      { x: 0.5, y: 6.28, w: 12.3, h: 0.72, fontSize: 11, fontFace: FONT, valign: 'top', line: { color: hex(BRAND.amber), width: 0.75 }, fill: { color: hex(BRAND.bg2) }, margin: 6 },
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
      // §3a-2 — numbered list (1. 2. 3.), matching the XLSX recommendations
      // sheet, instead of undifferentiated bullets.
      items.push({ text: `${i + 1}. ${r}`, options: { fontSize: 13, color: 'FFFFFF', indent: 18, paraSpaceAfter: 12 } });
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

  // ── PR 2: CREATIVE ATTENTION DEPTH SLIDES ──────────────────────────────
  // CA has no survey; its depth lives in mission.creative_analysis. These
  // slides surface the fields the deck previously dropped (effectiveness
  // breakdown, vs-benchmark, platform-fit rationale, frame diagnostics +
  // hotspots, full 24-emotion profile). Guarded on goal_type so every other
  // methodology's deck is byte-identical. All content boxes end by y=7.0,
  // clear of the 7.15 footer.
  const caData = (mission.goal_type === 'creative_attention'
    && mission.creative_analysis && typeof mission.creative_analysis === 'object')
    ? mission.creative_analysis : null;
  if (caData) {
    const ce = caData.creative_effectiveness || {};
    const caSum = caData.summary || {};
    const frames = Array.isArray(caData.frame_analyses) ? caData.frame_analyses : [];

    // Slide: effectiveness breakdown (component / score / weight).
    if (ce.components && typeof ce.components === 'object') {
      const slide = pptx.addSlide();
      addDarkBackground(slide);
      addSectionHeader(slide, '· EFFECTIVENESS BREAKDOWN', `How the ${ce.score != null ? ce.score + '/100 ' : ''}score is composed`);
      const weights = ce.weights || {};
      const rows = [[
        { text: 'Component', options: { bold: true, color: hex(BRAND.text3) } },
        { text: 'Score (0-100)', options: { bold: true, color: hex(BRAND.text3), align: 'right' } },
        { text: 'Weight', options: { bold: true, color: hex(BRAND.text3), align: 'right' } },
      ]];
      Object.entries(ce.components)
        .map(([k, v]) => ({ k, v: Math.round(Number(v) || 0), w: Number(weights[k]) || 0 }))
        .sort((a, b) => b.w - a.w)
        .forEach(({ k, v, w }) => rows.push([
          { text: k.replace(/_/g, ' '), options: { color: hex(BRAND.text1) } },
          { text: String(v), options: { color: hex(BRAND.lime), align: 'right' } },
          { text: w ? `${Math.round(w * 100)}%` : '', options: { color: hex(BRAND.text2), align: 'right' } },
        ]));
      slide.addTable(rows, {
        x: 0.5, y: 1.65, w: 12.3, h: Math.min(4.6, 0.42 * rows.length), fontSize: 12, fontFace: FONT,
        colW: [7.3, 2.5, 2.5], border: { type: 'solid', color: hex(BRAND.border), pt: 0.5 },
      });
      if (ce.band_explanation) {
        slide.addText(String(ce.band_explanation), {
          x: 0.5, y: 5.1, w: 12.3, h: 1.85, fontSize: 11, color: hex(BRAND.text2), fontFace: FONT, valign: 'top', shrinkText: true,
        });
      }
    }

    // Slide: vs category benchmark + best platform fit (with rationale).
    const fits = Array.isArray(caSum.best_platform_fit) ? caSum.best_platform_fit : [];
    if (caSum.vs_benchmark || fits.length) {
      const slide = pptx.addSlide();
      addDarkBackground(slide);
      addSectionHeader(slide, '· PLATFORM FIT', 'Where this creative earns attention, and why');
      const items = [];
      if (caSum.vs_benchmark) {
        items.push({ text: 'VS CATEGORY BENCHMARK', options: { fontSize: 10, bold: true, color: hex(BRAND.lime), charSpacing: 2 } });
        items.push({ text: '', options: { breakLine: true } });
        items.push({ text: String(caSum.vs_benchmark), options: { fontSize: 12, color: hex(BRAND.text1), paraSpaceAfter: 12 } });
        items.push({ text: '', options: { breakLine: true } });
      }
      fits.slice()
        .sort((a, b) => (b.fit_score ?? 0) - (a.fit_score ?? 0))
        .forEach((f) => {
          items.push({ text: `${f.platform} · ${Math.round(Number(f.fit_score) || 0)}/100`, options: { fontSize: 13, bold: true, color: 'FFFFFF', bullet: { code: '25CF' } } });
          if (f.rationale) {
            items.push({ text: '', options: { breakLine: true } });
            items.push({ text: String(f.rationale), options: { fontSize: 10.5, color: hex(BRAND.text2), paraSpaceAfter: 8 } });
          }
        });
      slide.addText(items, { x: 0.5, y: 1.65, w: 12.3, h: 5.3, fontFace: FONT, valign: 'top', shrinkText: true });
    }

    // Slide: frame diagnostics (description, clarity, resonance, hotspots).
    if (frames.length) {
      const slide = pptx.addSlide();
      addDarkBackground(slide);
      const FRAME_CAP = 6;
      const shown = frames.slice(0, FRAME_CAP);
      addSectionHeader(slide, '· FRAME READ', frames.length > FRAME_CAP
        ? `First ${FRAME_CAP} of ${frames.length} frames (full list in PDF and XLSX)`
        : (frames.length === 1 ? 'What the single frame communicates' : 'What each frame communicates'));
      const items = [];
      shown.forEach((f, i) => {
        if (i > 0) items.push({ text: '', options: { breakLine: true } });
        const head = [`Frame ${i + 1}`];
        if (f.message_clarity != null) head.push(`clarity ${f.message_clarity}`);
        if (f.audience_resonance != null) head.push(`resonance ${f.audience_resonance}`);
        if (f.engagement_score != null) head.push(`engagement ${f.engagement_score}`);
        items.push({ text: head.join(' · '), options: { fontSize: 13, bold: true, color: 'FFFFFF', bullet: { code: '25CF' } } });
        if (f.brief_description) {
          items.push({ text: '', options: { breakLine: true } });
          items.push({ text: String(f.brief_description), options: { fontSize: 11, color: hex(BRAND.text1), paraSpaceAfter: 4 } });
        }
        if (Array.isArray(f.attention_hotspots) && f.attention_hotspots.length) {
          items.push({ text: '', options: { breakLine: true } });
          items.push({ text: `Hotspots: ${f.attention_hotspots.join(' · ')}`, options: { fontSize: 10.5, color: hex(BRAND.text2), paraSpaceAfter: 8 } });
        }
      });
      slide.addText(items, { x: 0.5, y: 1.65, w: 12.3, h: 5.3, fontFace: FONT, valign: 'top', shrinkText: true });
    }

    // Slide: full 24-emotion profile, frame-averaged, two columns.
    {
      const sums = new Map();
      for (const f of frames) {
        for (const [name, v] of Object.entries((f && f.emotions) || {})) {
          const n = Number(v);
          if (!Number.isFinite(n)) continue;
          const cur = sums.get(name) || { total: 0, count: 0 };
          cur.total += n; cur.count += 1;
          sums.set(name, cur);
        }
      }
      const emotions = [...sums.entries()]
        .map(([name, { total, count }]) => ({ name: name.replace(/_/g, ' '), score: Math.round(total / Math.max(1, count)) }))
        .sort((a, b) => b.score - a.score);
      if (emotions.length) {
        const slide = pptx.addSlide();
        addDarkBackground(slide);
        addSectionHeader(slide, '· FULL EMOTION PROFILE', `${emotions.length} emotions scored 0-100${frames.length > 1 ? ', averaged across frames' : ''}`);
        const half = Math.ceil(emotions.length / 2);
        const col = (list, x) => {
          const items = [];
          list.forEach((e) => {
            items.push({ text: `${e.score}`.padStart(3, ' ') + `  ${e.name}`, options: {
              fontSize: 12, color: e.score > 50 ? hex(BRAND.lime) : hex(BRAND.text2),
              bold: e.score > 50, paraSpaceAfter: 5,
            } });
          });
          slide.addText(items, { x, y: 1.65, w: 5.9, h: 5.3, fontFace: FONT, valign: 'top' });
        };
        col(emotions.slice(0, half), 0.5);
        col(emotions.slice(half), 6.6);
      }
    }
  }

  // ── SURVEY (curated for a DECK, not the full document) ──
  // §9 — a deck should SUMMARISE, not reproduce every raw task. Skip the
  // repetitive instrument-mechanic questions (MaxDiff / Kano / forced-choice /
  // paired-comparison) whose aggregate IS the centerpiece, and cap the rest. The
  // PDF + XLSX still render every question — this only de-densifies the deck
  // (e.g. an n=5 roadmap was 30 slides, ~23 of them near-identical MaxDiff/Kano).
  const INSTRUMENT_RENDERERS = new Set(['max_diff', 'kano', 'forced_choice', 'paired_comparison']);
  const MAX_SURVEY_SLIDES = 12;
  const allSurvey = Array.isArray(model.survey) ? model.survey : [];
  const deckSurvey = allSurvey.filter((q) => !INSTRUMENT_RENDERERS.has(q.renderer));
  const shownSurvey = deckSurvey.slice(0, MAX_SURVEY_SLIDES);
  shownSurvey.forEach((q, qi) => {
    const slide = pptx.addSlide();
    addDarkBackground(slide);
    // D1/D2 — the header carries the tag (eyebrow) + the QUESTION (title); the
    // narration moves to a "WHAT THIS MEANS" box BELOW the chart, mirroring the
    // PDF, so the headline never collides with the question header. The screener
    // tag is de-duped: renderer_label is already "SCREENER" for a screener, so
    // don't also append "· SCREENER".
    const typeTag = (q.renderer_label || '').toUpperCase();
    const screenerTag = (q.isScreening && q.renderer !== 'screener') ? ' · SCREENER' : '';
    const tag = `${String(qi + 5).padStart(2, '0')} · Q${q.number} · ${typeTag}${screenerTag}`;
    // Dynamic header band so a long question never collides with the eyebrow or
    // the chart. Font shrinks only as far as needed; short questions keep 24pt and
    // land on the SAME divider (1.40) / body (1.65) as before — Math.max clamps
    // hold the short-question layout byte-stable and only push down for long ones.
    const titleY = 0.65;
    const titleFontSize = fitTitleFontSize(q.text);
    const titleLines = estTitleLines(q.text, titleFontSize);
    const titleH = titleLines * titleLineHeight(titleFontSize) + 0.06;
    const dividerY = Math.max(1.40, titleY + titleH + 0.12);
    const bodyY = Math.max(1.65, dividerY + 0.22);
    addSectionHeader(slide, tag, q.text, {
      titleFontSize, titleY, titleH, dividerY, titleValign: 'top',
    });
    const insight = (q.insight && String(q.insight).trim()) ? String(q.insight).trim() : '';
    // Chart fills from bodyY down to the WHATS-THIS-MEANS box (5.70) or slide end
    // (6.85); a taller header shrinks the chart, floored so it stays usable.
    const bodyBottom = insight ? 5.70 : 6.85;
    renderSurveyBody(slide, q, {
      x: 0.5, y: bodyY, w: 12.3, h: Math.max(2.6, bodyBottom - bodyY),
    });
    if (insight) {
      // The narration box must END ABOVE the slide footer. The footer
      // ("VETT · vettit.ai", addDarkBackground) occupies y 7.15 to 7.45, but the
      // insight box used to run 6.12 -> 7.32, i.e. it punched 0.17" INTO the
      // footer and the narration text collided with it on every slide that
      // carries an insight (107 slides across 12 of 13 decks in the export
      // sweep). Bottom is now 7.05, leaving a 0.10" gap before the footer.
      slide.addText('WHAT THIS MEANS', {
        x: 0.5, y: 5.78, w: 12.3, h: 0.26, fontSize: 10, bold: true, color: hex(BRAND.lime), fontFace: FONT, charSpacing: 2,
      });
      slide.addText(insight, {
        x: 0.5, y: 6.06, w: 12.3, h: 0.99, fontSize: 12, color: hex(BRAND.text1), fontFace: FONT, valign: 'top', shrinkText: true,
      });
    }
  });
  // One note slide when the deck omitted questions — point to the full exports.
  const omittedCount = allSurvey.length - shownSurvey.length;
  if (omittedCount > 0) {
    const instrumentCount = allSurvey.length - deckSurvey.length;
    const slide = pptx.addSlide();
    addDarkBackground(slide);
    addSectionHeader(slide, '· FULL SURVEY', `${shownSurvey.length} of ${allSurvey.length} questions shown`);
    const lines = [`This deck summarises the survey; ${omittedCount} question${omittedCount === 1 ? '' : 's'} omitted here for brevity.`];
    if (instrumentCount > 0) lines.push(`Includes ${instrumentCount} MaxDiff / Kano / forced-choice instrument task${instrumentCount === 1 ? '' : 's'}; their aggregate is the centerpiece above.`);
    lines.push('The complete per-question breakdown is in the PDF and XLSX exports.');
    slide.addText(lines.map((t) => ({ text: t, options: { fontSize: 14, color: hex(BRAND.text2), bullet: { code: '25CF', indent: 18 }, paraSpaceAfter: 12, breakLine: true } })), {
      x: 0.5, y: 1.65, w: 12.3, h: 5, fontFace: FONT, valign: 'top',
    });
  }

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
