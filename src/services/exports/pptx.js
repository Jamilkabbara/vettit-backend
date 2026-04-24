/**
 * VETT — PowerPoint export using pptxgenjs.
 * Dark-theme slide deck that mirrors the HTML prototype aesthetic:
 *   - Near-black slide background (#0B0C15)
 *   - Lime (#BEF264) accents and headline colour
 *   - Inter-like sans (Calibri fallback — pptx uses system fonts)
 *
 * Slide outline:
 *   1. Cover              (VETT wordmark + title + meta)
 *   2. Executive summary  (big paragraph — autoFit)
 *   3. KPI snapshot       (exactly 3 stat cards)
 *   4..N. One slide per question (chart + insight pullquote)
 *   N+1. Recommendations
 *   N+2. Follow-ups
 *
 * Bug 3 fix:  multi-select % uses n_respondents denominator, not total clicks.
 * Bug 6 fix:  recommendations/follow-ups use breakLine for real paragraph breaks.
 * Bug 7 fix:  chart labels and verbatims no longer truncated at 28/220 chars.
 * Bug 8 fix:  exactly 3 KPIs (prompt already capped; layout positions 3 evenly).
 * Bug 11 fix: exec summary text box has autoFit: true.
 */

const PptxGenJS = require('pptxgenjs');
const { BRAND } = require('./shared');

// pptxgenjs uses hex codes without the leading '#'
const hex = (c) => (c || '').replace('#', '');

function addDarkBackground(slide) {
  slide.background = { color: hex(BRAND.bg) };
  // Thin lime accent bar across the very top
  slide.addShape('rect', {
    x: 0, y: 0, w: '100%', h: 0.06,
    fill: { color: hex(BRAND.lime) },
    line: { color: hex(BRAND.lime) },
  });
  // Footer — bottom of 7.5" wide slide, well clear of chart content
  slide.addText('VETT  ·  vettit.ai', {
    x: 0.5, y: 7.15, w: 12.3, h: 0.3,
    fontSize: 9, color: hex(BRAND.text3), fontFace: 'Calibri',
    align: 'center',
  });
}

function addSectionHeader(slide, eyebrow, title) {
  slide.addText(eyebrow, {
    x: 0.5, y: 0.35, w: 9, h: 0.3,
    fontSize: 10, bold: true, color: hex(BRAND.lime),
    fontFace: 'Calibri', charSpacing: 80,
  });
  slide.addText(title, {
    x: 0.5, y: 0.65, w: 9, h: 0.6,
    fontSize: 24, bold: true, color: 'FFFFFF', fontFace: 'Calibri',
  });
  // Lime divider
  slide.addShape('rect', {
    x: 0.5, y: 1.25, w: 9, h: 0.03,
    fill: { color: hex(BRAND.lime) }, line: { color: hex(BRAND.lime) },
  });
}

function statCard(slide, x, y, w, h, label, value, trendColor = BRAND.lime) {
  slide.addShape('roundRect', {
    x, y, w, h, rectRadius: 0.1,
    fill: { color: hex(BRAND.bg2) }, line: { color: hex(BRAND.border) },
  });
  slide.addText(String(label || '').toUpperCase(), {
    x: x + 0.15, y: y + 0.1, w: w - 0.3, h: 0.3,
    fontSize: 9, color: hex(BRAND.text3), fontFace: 'Calibri', charSpacing: 60,
  });
  slide.addText(String(value || '—'), {
    x: x + 0.15, y: y + 0.4, w: w - 0.3, h: h - 0.5,
    fontSize: 28, bold: true, color: hex(trendColor), fontFace: 'Calibri',
  });
}

function buildPPTX(pack, res) {
  const { mission, insights, aggregatedByQuestion } = pack;

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';     // 13.333 × 7.5 in
  pptx.title = mission.title || 'VETT Research Report';
  pptx.company = 'VETT';
  pptx.subject = mission.brief || mission.mission_statement || '';

  // ── COVER ─────────────────────────────────────────────────
  const cover = pptx.addSlide();
  cover.background = { color: hex(BRAND.bg) };
  cover.addShape('rect', {
    x: 0, y: 0, w: '100%', h: 0.1,
    fill: { color: hex(BRAND.lime) }, line: { color: hex(BRAND.lime) },
  });
  cover.addText('VETT', {
    x: 0.7, y: 0.6, w: 6, h: 1.2,
    fontSize: 72, bold: true, color: hex(BRAND.lime), fontFace: 'Calibri',
  });
  cover.addText('AI-POWERED MARKET RESEARCH', {
    x: 0.7, y: 1.8, w: 10, h: 0.4,
    fontSize: 12, color: hex(BRAND.text2), fontFace: 'Calibri', charSpacing: 200,
  });
  cover.addText(mission.title || 'Research Report', {
    x: 0.7, y: 2.8, w: 12, h: 1.2,
    fontSize: 36, bold: true, color: 'FFFFFF', fontFace: 'Calibri',
  });
  cover.addText(mission.brief || mission.mission_statement || '', {
    x: 0.7, y: 4.2, w: 12, h: 1.4,
    fontSize: 14, color: hex(BRAND.text2), fontFace: 'Calibri',
  });
  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  cover.addText(
    [
      { text: 'Respondents: ', options: { color: hex(BRAND.text3) } },
      { text: `${mission.respondent_count || '—'}    `, options: { color: 'FFFFFF', bold: true } },
      { text: 'Date: ', options: { color: hex(BRAND.text3) } },
      { text: `${now}    `, options: { color: 'FFFFFF', bold: true } },
      { text: 'Mission: ', options: { color: hex(BRAND.text3) } },
      { text: String(mission.id || '').slice(0, 8), options: { color: 'FFFFFF', bold: true } },
    ],
    { x: 0.7, y: 6.4, w: 12, h: 0.4, fontSize: 10, fontFace: 'Calibri' }
  );

  // ── EXECUTIVE SUMMARY ─────────────────────────────────────
  const summary = pptx.addSlide();
  addDarkBackground(summary);
  addSectionHeader(summary, '01 · EXECUTIVE SUMMARY', 'What the research says');
  // Bug 11 fix: autoFit so long summaries never clip at the frame edge
  summary.addText(insights.executive_summary || 'Executive summary unavailable.', {
    x: 0.5, y: 1.6, w: 12.3, h: 4.5,
    fontSize: 16, color: hex(BRAND.text1), fontFace: 'Calibri',
    paraSpaceAfter: 8, valign: 'top',
    autoFit: true,
  });

  // ── KPI SNAPSHOT ──────────────────────────────────────────
  // Bug 8 fix: layout assumes exactly 3 KPIs (prompt instructs Claude to return 3).
  if (Array.isArray(insights.kpis) && insights.kpis.length > 0) {
    const kpiSlide = pptx.addSlide();
    addDarkBackground(kpiSlide);
    addSectionHeader(kpiSlide, '02 · HEADLINE KPIs', 'The numbers that matter');

    const kpis = insights.kpis.slice(0, 3);
    const cardW = 3.8;
    const cardH = 2.2;
    const totalW = kpis.length * cardW + (kpis.length - 1) * 0.3;
    const startX = (13.333 - totalW) / 2;

    kpis.forEach((kpi, i) => {
      const tc = kpi.trend === 'negative' ? BRAND.red
               : kpi.trend === 'neutral'  ? BRAND.text1
               : BRAND.lime;
      statCard(kpiSlide, startX + i * (cardW + 0.3), 2.3, cardW, cardH, kpi.label, kpi.value, tc);
    });
  }

  // ── PER-QUESTION SLIDES ───────────────────────────────────
  (mission.questions || []).forEach((q, qi) => {
    const slide = pptx.addSlide();
    addDarkBackground(slide);
    addSectionHeader(slide, `${String(qi + 3).padStart(2, '0')} · QUESTION ${qi + 1}`, q.text);

    const qAgg = aggregatedByQuestion[q.id] || {};
    const qInsight = (insights.per_question_insights || []).find(pi => pi.question_id === q.id);

    if (q.type === 'rating') {
      const dist = qAgg.distribution || {};
      const total = Object.values(dist).reduce((s, v) => s + v, 0) || 1;
      const chartData = [{
        name: 'Responses',
        labels: ['1 Star', '2 Stars', '3 Stars', '4 Stars', '5 Stars'],
        values: [1,2,3,4,5].map(r => Math.round(((dist[r] || 0) / total) * 100)),
      }];
      slide.addChart(pptx.ChartType.bar, chartData, {
        x: 0.5, y: 1.5, w: 8, h: 4.5,
        chartColors: [hex(BRAND.lime)],
        barDir: 'bar',
        showTitle: true, title: `Average: ${qAgg.average || 0} / 5  ·  n=${qAgg.n || 0}`,
        titleColor: hex(BRAND.text1), titleFontSize: 12,
        catAxisLabelColor: hex(BRAND.text2), valAxisLabelColor: hex(BRAND.text2),
        plotArea: { fill: { color: hex(BRAND.bg) } },
        showLegend: false,
      });
    } else if (q.type === 'text') {
      // Bug 7: no .slice(0, 220) — render full verbatims
      const items = (qAgg.verbatims || []).slice(0, 5).map(v => ({
        text: `"${String(v)}"`,
        options: {
          bullet: { code: '25CF' }, color: hex(BRAND.text2),
          italic: true, fontSize: 13, paraSpaceAfter: 8,
          breakLine: false,
        },
      }));
      // Add breakLine between verbatims for proper paragraph separation
      const separated = [];
      items.forEach((item, i) => {
        separated.push(item);
        if (i < items.length - 1) {
          separated.push({ text: '', options: { breakLine: true } });
        }
      });
      if (separated.length === 0) {
        separated.push({ text: 'No text responses yet.', options: { color: hex(BRAND.text3), fontSize: 13 } });
      }
      slide.addText(separated, { x: 0.5, y: 1.6, w: 12.3, h: 4.4, fontFace: 'Calibri', valign: 'top' });
    } else if (q.type === 'multi') {
      // Bug 3: use n_respondents denominator for multi-select percentages
      const dist = qAgg.distribution || {};
      const nRespondents = qAgg.n_respondents || qAgg.n || 1;
      const entries = Object.entries(dist).sort((a, b) => b[1] - a[1]).slice(0, 8);
      // Bug 7: no .slice(0, 28) on labels
      const chartData = [{
        name: 'Responses',
        labels: entries.map(([k]) => String(k)),
        values: entries.map(([, v]) => Math.round((v / nRespondents) * 100)),
      }];
      slide.addChart(pptx.ChartType.bar, chartData, {
        x: 0.5, y: 1.5, w: 8, h: 4.5,
        chartColors: [hex(BRAND.lime)],
        barDir: 'bar',
        showTitle: true,
        title: `n=${nRespondents} respondents (multi-select, totals may exceed 100%)`,
        titleColor: hex(BRAND.text2), titleFontSize: 10,
        catAxisLabelColor: hex(BRAND.text2), valAxisLabelColor: hex(BRAND.text2),
        plotArea: { fill: { color: hex(BRAND.bg) } },
        showLegend: false,
      });
    } else {
      // single / opinion — Bug 7: no .slice(0, 28) on labels
      const dist = qAgg.distribution || {};
      const entries = Object.entries(dist).sort((a, b) => b[1] - a[1]).slice(0, 8);
      const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
      const chartData = [{
        name: 'Responses',
        labels: entries.map(([k]) => String(k)),
        values: entries.map(([, v]) => Math.round((v / total) * 100)),
      }];
      slide.addChart(pptx.ChartType.bar, chartData, {
        x: 0.5, y: 1.5, w: 8, h: 4.5,
        chartColors: [hex(BRAND.lime)],
        barDir: 'bar',
        catAxisLabelColor: hex(BRAND.text2), valAxisLabelColor: hex(BRAND.text2),
        plotArea: { fill: { color: hex(BRAND.bg) } },
        showLegend: false,
      });
    }

    // Screening context note — above footer (footer now at y:7.15)
    if (qAgg.is_screening && qAgg.n_total) {
      slide.addText(`Screening question · all ${qAgg.n_total} respondents shown`, {
        x: 0.5, y: 6.6, w: 12.3, h: 0.25,
        fontSize: 9, color: hex(BRAND.text3), italic: true, fontFace: 'Calibri',
        align: 'left',
      });
    }

    // Insight pullquote on the right
    if (qInsight?.headline) {
      slide.addShape('roundRect', {
        x: 8.7, y: 1.5, w: 4.3, h: 4.5, rectRadius: 0.08,
        fill: { color: hex(BRAND.bg2) }, line: { color: hex(BRAND.border) },
      });
      slide.addShape('rect', {
        x: 8.7, y: 1.5, w: 0.06, h: 4.5,
        fill: { color: hex(BRAND.lime) }, line: { color: hex(BRAND.lime) },
      });
      slide.addText('INSIGHT', {
        x: 8.9, y: 1.65, w: 4, h: 0.3,
        fontSize: 9, bold: true, color: hex(BRAND.lime), fontFace: 'Calibri', charSpacing: 120,
      });
      slide.addText(qInsight.headline, {
        x: 8.9, y: 2.0, w: 4, h: 1.3,
        fontSize: 16, bold: true, color: 'FFFFFF', fontFace: 'Calibri',
      });
      slide.addText(qInsight.body || '', {
        x: 8.9, y: 3.3, w: 4, h: 2.5,
        fontSize: 11, color: hex(BRAND.text2), fontFace: 'Calibri', valign: 'top',
      });
    }
  });

  // ── RECOMMENDATIONS ──────────────────────────────────────
  // Bug 6 fix: use breakLine: true between items so paragraphs render separately.
  // Each recommendation: bold number prefix (lime 12pt) + body text (14pt).
  if (Array.isArray(insights.recommendations) && insights.recommendations.length) {
    const slide = pptx.addSlide();
    addDarkBackground(slide);
    addSectionHeader(slide, '· RECOMMENDATIONS', 'What to do next');
    const items = [];
    insights.recommendations.forEach((r, i) => {
      if (i > 0) items.push({ text: '', options: { breakLine: true } });
      items.push({
        text: `${String(i + 1).padStart(2, '0')}.`,
        options: { bold: true, fontSize: 12, color: hex(BRAND.lime) },
      });
      items.push({
        text: `  ${r}`,
        options: { fontSize: 14, color: hex(BRAND.text1), paraSpaceAfter: 12 },
      });
    });
    slide.addText(items, { x: 0.5, y: 1.6, w: 12.3, h: 4.5, fontFace: 'Calibri', valign: 'top' });
  }

  // ── FOLLOW-UPS ────────────────────────────────────────────
  // Bug 6 fix: each follow-up title + rationale in its own paragraph block.
  if (Array.isArray(insights.follow_ups) && insights.follow_ups.length) {
    const slide = pptx.addSlide();
    addDarkBackground(slide);
    addSectionHeader(slide, '· RECOMMENDED FOLLOW-UPS', 'The logical next research');
    const items = [];
    insights.follow_ups.forEach((fu, i) => {
      if (i > 0) items.push({ text: '', options: { breakLine: true } });
      items.push({
        text: fu.title || '',
        options: { fontSize: 16, bold: true, color: 'FFFFFF', paraSpaceBefore: 4 },
      });
      items.push({ text: '', options: { breakLine: true } });
      items.push({
        text: fu.rationale || '',
        options: { fontSize: 12, color: hex(BRAND.text2), paraSpaceAfter: 14 },
      });
    });
    slide.addText(items, { x: 0.5, y: 1.6, w: 12.3, h: 4.5, fontFace: 'Calibri', valign: 'top' });
  }

  // ── Stream to response ────────────────────────────────────
  const fname = `vett-report-${(mission.title || mission.id).toString().slice(0, 40).replace(/[^a-z0-9]+/gi, '-')}.pptx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);

  return pptx.stream().then((buffer) => {
    res.end(Buffer.from(buffer));
  });
}

module.exports = { buildPPTX };
