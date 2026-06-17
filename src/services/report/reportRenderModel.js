/**
 * Pass 48 Phase 3 — the SHARED render model.
 *
 * One function, `buildRenderModel(report)`, flattens the CanonicalReport
 * (from buildReport.js) into a format-agnostic, render-ready view model
 * that EVERY export builder (XLSX / PPTX / PDF / JSON) consumes. Because
 * all formats iterate the SAME flattened structure, in the SAME order,
 * the exports come out STRUCTURALLY IDENTICAL — compare, brand_lift,
 * satisfaction all render the same sections in the same sequence.
 *
 * The defining contract: per-question survey rows are shaped here ONCE
 * from each question's `renderer` (0-10 / 1-7 / 1-5 / generic / choice /
 * multi / attribute battery / max_diff / verbatims). The bar percentages
 * and the "Average X / scale_max" lines mirror the web FullSurveySection
 * exactly — so an export of a 0-10 NPS shows a 0-10 distribution (never a
 * 5-star "7/5"), and a 1-7 CES shows 1-7 buckets (never an empty "0/5").
 *
 * NO numbers are recomputed here. Every value is read from the canonical
 * report's already-correct `data` shapes. The render model only re-arranges
 * them into rows/bars/tables the export libraries can paint.
 */

/** Integer percent of a part over a total (0 when total is 0). Mirrors web pct(). */
function pct(n, total) {
  return total > 0 ? Math.round((n / total) * 100) : 0;
}

function sum(values) {
  return values.reduce((s, v) => s + (Number(v) || 0), 0);
}

/**
 * Shape one survey question's `data` into a uniform "body" the formats render.
 * Returns one of:
 *   { kind: 'scale',     headline, bars:[{label,count,pct}], scale_max, n, average, ci }
 *   { kind: 'bars',      bars:[{label,count,pct}], note?, empty? }   // choice / multi
 *   { kind: 'matrix',    rows:[{label, average, n, pct}] }            // attribute battery (per-attribute)
 *   { kind: 'maxdiff',   rows:[{label, best, worst}] }
 *   { kind: 'verbatims', items:[...], extra }                         // open text
 * Empty states are signalled with `empty:true` (+ a human message) so every
 * format can render the SAME "No responses recorded." copy as the web.
 */
function shapeSurveyBody(q) {
  const r = q.renderer || '';
  const data = q.data || {};

  if (r.startsWith('scale_')) {
    const dist = data.distribution || {};
    const keys = Object.keys(dist).map(Number).filter((k) => !Number.isNaN(k)).sort((a, b) => a - b);
    const total = sum(keys.map((k) => dist[k]));
    const ci = (data.ci_low != null && data.ci_high != null)
      ? `95% CI ${data.ci_low}–${data.ci_high}` : null;
    return {
      kind: 'scale',
      scale_min: data.scale_min,
      scale_max: data.scale_max,
      average: data.average,
      n: data.n || 0,
      ci,
      headline: `Average ${data.average ?? '—'} / ${data.scale_max} (n=${data.n || 0}${ci ? ` · ${ci}` : ''})`,
      bars: keys.map((k) => ({ label: String(k), count: dist[k] || 0, pct: pct(dist[k] || 0, total) })),
    };
  }

  if (r === 'open_text_verbatims') {
    const items = Array.isArray(data.verbatims) ? data.verbatims : [];
    // P2-1 — open-end themes (theme-frequency bars + sentiment + quotes). When
    // present, the open-end renders as a VISUAL, not a verbatims punt; the raw
    // verbatims still ride along (shown beneath the themes, capped).
    const themes = (Array.isArray(data.themes) ? data.themes : [])
      .filter((t) => t && t.label)
      .map((t) => ({
        label: t.label,
        count: Number(t.count) || 0,
        pct: t.pct != null ? Number(t.pct) : pct(Number(t.count) || 0, data.n || items.length),
        sentiment: ['positive', 'negative', 'neutral'].includes(t.sentiment) ? t.sentiment : 'neutral',
        quotes: Array.isArray(t.quotes) ? t.quotes.filter((q) => typeof q === 'string' && q.trim()).slice(0, 2) : [],
      }));
    // §A6 — cap the verbatims shown in exports so a long open-end can't fill a
    // page and orphan its insight callout onto the next. Display only; the full
    // set still drives theme clustering upstream. (Web reads the canonical data
    // directly and caps its own list.)
    const VERBATIM_DISPLAY = 8;
    return {
      kind: 'verbatims',
      empty: items.length === 0 && themes.length === 0,
      empty_message: 'No open-text responses.',
      themes,
      has_themes: themes.length > 0,
      items: items.slice(0, VERBATIM_DISPLAY),
      items_total: items.length,
      n: data.n || items.length,
    };
  }

  if (r === 'attribute_battery') {
    if (data.shape === 'matrix' && Array.isArray(data.per_attribute)) {
      // Pass 49 — fill bars over the battery's TRUE scale (1-7/0-10), not a
      // hardcoded /5, so a non-5 matrix isn't over/under-filled.
      const scaleMax = Number(data.scale_max) || 5;
      return {
        kind: 'matrix',
        n: data.n || 0,
        scale_max: scaleMax,
        rows: data.per_attribute.map((a) => ({
          label: a.attribute,
          average: a.average,
          n: a.n,
          pct: Math.min(100, Math.round(((Number(a.average) || 0) / scaleMax) * 100)),
        })),
      };
    }
    // endorsement shape → multi-select bars
    const dist = data.distribution || {};
    const base = data.n_respondents || data.n || 0;
    const entries = Object.entries(dist).sort((a, b) => b[1] - a[1]);
    return {
      kind: 'bars',
      empty: entries.length === 0,
      empty_message: 'No selections recorded.',
      note: `% of ${base} respondents (multi-select)`,
      base,
      bars: entries.map(([label, count]) => ({ label, count, pct: pct(count, base) })),
    };
  }

  if (r === 'multi_select') {
    const dist = data.distribution || {};
    const base = data.n_respondents || data.n || 0;
    const entries = Object.entries(dist).sort((a, b) => b[1] - a[1]);
    return {
      kind: 'bars',
      empty: entries.length === 0,
      empty_message: 'No selections recorded.',
      note: `% of ${base} respondents (multi-select)`,
      base,
      bars: entries.map(([label, count]) => ({ label, count, pct: pct(count, base) })),
    };
  }

  if (r === 'max_diff') {
    const best = data.best || {};
    const worst = data.worst || {};
    const feats = Array.from(new Set([...Object.keys(best), ...Object.keys(worst)]));
    return {
      kind: 'maxdiff',
      empty: feats.length === 0,
      empty_message: 'No best/worst picks recorded.',
      n: data.n || 0,
      rows: feats.map((f) => ({ label: f, best: best[f] || 0, worst: worst[f] || 0 })),
    };
  }

  // single_select / forced_choice / paired_comparison / screener / kano
  const dist = data.distribution || {};
  const entries = Object.entries(dist).sort((a, b) => b[1] - a[1]);
  const total = sum(entries.map(([, v]) => v));
  return {
    kind: 'bars',
    empty: entries.length === 0,
    empty_message: 'No responses recorded.',
    base: total,
    bars: entries.map(([label, count]) => ({ label, count, pct: pct(count, total) })),
  };
}

/**
 * Flatten the canonical report into the uniform render model. Sections are
 * always emitted in the SAME ORDER:
 *   1. header        (title, brief, sample meta rows)
 *   2. exec_summary  (prose, or null)
 *   3. headline      (the methodology's key computed metrics, label/value)
 *   4. centerpiece   (methodology instrument — brand-lift funnel table, etc.)
 *   5. key_findings  (insights.kpis)
 *   6. survey        (THE FULL SURVEY — every question, correct renderer)
 *   7. data_quality_notes
 *   8. methodology_disclaimer
 *
 * @param {object} report  CanonicalReport from buildCanonicalReport
 */
function buildRenderModel(report) {
  if (!report || typeof report !== 'object') {
    return { header: { title: 'Untitled', metaRows: [] }, headline: null, centerpiece: null,
      keyFindings: [], recommendations: [], survey: [], dataQualityNotes: [], execSummary: null, disclaimer: null,
      finding: null, synthesis: null, screening: null, personas: [] };
  }

  const h = report.header || {};
  const sample = h.sample || {};

  // ── header meta rows (uniform key/value strip every format renders) ──
  const metaRows = [];
  const addMeta = (k, v) => { if (v !== null && v !== undefined && v !== '') metaRows.push([k, String(v)]); };
  addMeta('Methodology', h.methodology_label);
  addMeta('Respondents (n)', sample.n);
  if (sample.qualified != null) addMeta('Qualified', sample.qualified);
  if (sample.delivered != null) addMeta('Delivered', sample.delivered);
  addMeta('Confidence posture', sample.posture);
  if (sample.completed_at) {
    const d = new Date(sample.completed_at);
    addMeta('Mission completed', Number.isNaN(d.getTime()) ? sample.completed_at : d.toISOString().slice(0, 10));
  }
  addMeta('Mission ID', sample.mission_id);

  // ── headline (key computed metrics — label/value) ──
  const headline = report.headline && Array.isArray(report.headline.all) && report.headline.all.length
    ? { primary: { label: report.headline.metric, value: report.headline.value }, all: report.headline.all }
    : null;

  // ── centerpiece: the methodology instrument as a structured table when
  //    one is natural (brand-lift exposed-vs-control funnel is the headline
  //    case). The flat headline list above already carries the per-stage
  //    lines, so the centerpiece table is the RICHER per-stage exposed/
  //    control/lift/significance grid. ──
  const centerpiece = buildCenterpiece(report.centerpiece);

  // ── key findings (insights.kpis: strings or {title/headline, description/body}) ──
  const keyFindings = (report.key_findings || []).map((f) => {
    if (typeof f === 'string') return { title: f, body: '' };
    return { title: f.title || f.headline || f.label || '', body: f.description || f.body || '', value: f.value, trend: f.trend };
  }).filter((f) => f.title || f.value);

  // ── B1 — recommendations (grounded action list) ──
  const recommendations = (report.recommendations || []).filter((r) => typeof r === 'string' && r.trim());

  // ── full survey: every question → uniform body ──
  const survey = (report.survey || []).map((q) => ({
    number: q.number,
    id: q.id,
    text: q.text,
    renderer: q.renderer,
    renderer_label: q.renderer_label,
    isScreening: !!q.isScreening,
    insight: q.insight || null,
    body: shapeSurveyBody(q),
  }));

  return {
    header: {
      title: h.title || 'Untitled mission',
      brief: h.brief || '',
      methodology_label: h.methodology_label || 'Research Study',
      metaRows,
    },
    execSummary: report.exec_summary || null,
    // §3 — mockup content beats, from the one canonical source.
    finding: report.finding || null,
    synthesis: report.synthesis || report.exec_summary || null,
    screening: report.screening || null,
    personas: Array.isArray(report.personas) ? report.personas : [],
    headline,
    centerpiece,
    keyFindings,
    recommendations,
    survey,
    dataQualityNotes: (report.data_quality_notes || []).map((n) => ({
      question_number: n.question_number,
      note: n.note,
    })),
    disclaimer: report.methodology_disclaimer || null,
  };
}

/**
 * Build the centerpiece "instrument" view from the methodology analysis.
 * Returns null when there's no natural structured table beyond the flat
 * headline metrics. For brand_lift this is the FULL exposed-vs-control
 * funnel (every stage), which is the whole point of the methodology — not
 * a single numeric stage.
 */
function buildCenterpiece(centerpiece) {
  if (!centerpiece || typeof centerpiece !== 'object') return null;
  const analysis = centerpiece.data;
  if (!analysis || typeof analysis !== 'object') return null;
  const methodology = centerpiece.methodology || analysis.methodology;

  if (methodology === 'brand_lift') {
    const rows = [];
    for (const f of analysis.funnel || []) {
      if (!f || f.lift_abs == null) continue;
      const stage = f.text || f.funnel_stage || f.question_id || 'Stage';
      if (f.type === 'proportion') {
        rows.push({
          stage,
          exposed: f.exposed?.rate != null ? `${Math.round(f.exposed.rate * 100)}%` : '—',
          control: f.control?.rate != null ? `${Math.round(f.control.rate * 100)}%` : '—',
          lift: `+${Math.round(f.lift_abs * 100)} pts`,
          significance: sigLabel(f.significance),
          n: `${f.exposed?.n ?? '?'} / ${f.control?.n ?? '?'}`,
        });
      } else if (f.type === 'mean') {
        rows.push({
          stage,
          exposed: f.exposed?.mean != null ? String(f.exposed.mean) : '—',
          control: f.control?.mean != null ? String(f.control.mean) : '—',
          lift: `+${f.lift_abs}`,
          significance: sigLabel(f.significance),
          n: `${f.exposed?.n ?? '?'} / ${f.control?.n ?? '?'}`,
        });
      }
    }
    if (rows.length === 0) return null;
    return {
      title: 'Exposed vs. control funnel',
      columns: ['Funnel stage', 'Exposed', 'Control', 'Lift', 'Significance', 'n (exp/ctrl)'],
      rows: rows.map((r) => [r.stage, r.exposed, r.control, r.lift, r.significance, r.n]),
    };
  }

  // Other methodologies: the flat headline list already carries the
  // instrument numbers (VW points + GG for pricing, NPS/CSAT/CES for
  // satisfaction, forced-choice shares for compare, …). No extra table.
  return null;
}

function sigLabel(sig) {
  if (!sig) return 'directional';
  if (sig.sig95) return 'significant at 95%';
  if (sig.sig90) return 'significant at 90%';
  return 'directional';
}

module.exports = { buildRenderModel, shapeSurveyBody, pct };
