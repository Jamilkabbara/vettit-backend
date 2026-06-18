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
    return { header: { title: 'Untitled', metaRows: [] }, headline: null, centerpiece: null, gate: null,
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
    // §2.4 — statistical-integrity gate, carried into every export so the PDF/
    // PPTX/XLSX show the same directional banner the web does and never headline
    // a degenerate number.
    gate: (report.centerpiece && report.centerpiece.gate) || null,
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
      // §D2 — every KPI shows absolute lift (pp) AND relative lift (%) + sig.
      const rel = f.lift_rel_pct != null ? `${f.lift_rel_pct >= 0 ? '+' : ''}${Math.round(f.lift_rel_pct)}%` : '—';
      if (f.type === 'proportion') {
        rows.push({
          stage,
          exposed: f.exposed?.rate != null ? `${Math.round(f.exposed.rate * 100)}%` : '—',
          control: f.control?.rate != null ? `${Math.round(f.control.rate * 100)}%` : '—',
          abs: `${f.lift_abs >= 0 ? '+' : ''}${Math.round(f.lift_abs * 100)} pp`,
          rel,
          significance: sigLabel(f.significance),
          n: `${f.exposed?.n ?? '?'} / ${f.control?.n ?? '?'}`,
        });
      } else if (f.type === 'mean') {
        rows.push({
          stage,
          exposed: f.exposed?.mean != null ? String(f.exposed.mean) : '—',
          control: f.control?.mean != null ? String(f.control.mean) : '—',
          abs: `${f.lift_abs >= 0 ? '+' : ''}${f.lift_abs}`,
          rel,
          significance: sigLabel(f.significance),
          n: `${f.exposed?.n ?? '?'} / ${f.control?.n ?? '?'}`,
        });
      }
    }
    if (rows.length === 0) return null;
    return {
      title: 'Exposed vs. control — lift on every KPI',
      columns: ['KPI', 'Exposed', 'Control', 'Abs. lift', 'Rel. lift', 'Significance', 'n (exp/ctrl)'],
      rows: rows.map((r) => [r.stage, r.exposed, r.control, r.abs, r.rel, r.significance, r.n]),
    };
  }

  // §4 export parity — market_entry has a per-market demand scorecard that the
  // web renders as MarketEntryHero; mirror it as a table so PDF/PPTX/XLSX carry
  // the same signature (the flat headline can't hold the per-market grid).
  if (methodology === 'market_entry') {
    const markets = Array.isArray(analysis.markets) ? analysis.markets : [];
    if (markets.length === 0) return null;
    const signalLabel = (s) => (s === 'go' ? 'GO' : s === 'caution' ? 'CAUTION' : s === 'no_go' ? 'NO-GO' : '—');
    return {
      title: 'Market demand scorecard — every target market',
      columns: ['Market', 'Demand (0-100)', 'Signal', 'Purchase intent', 'Appeal (1-7)', 'WTP', 'Top barrier', 'n'],
      rows: markets.map((m) => [
        m.directional ? `${m.market} (directional)` : m.market,
        m.demand_index != null ? String(m.demand_index) : '—',
        signalLabel(m.signal),
        m.purchase_intent_pct != null ? `${m.purchase_intent_pct}%` : '—',
        m.appeal_mean != null ? String(m.appeal_mean) : '—',
        m.wtp != null ? String(m.wtp) : '—',
        (m.barriers && m.barriers[0]) ? `${m.barriers[0].label} (${m.barriers[0].pct}%)` : '—',
        String(m.n ?? '?'),
      ]),
    };
  }

  // §4 export parity — audience_profiling has a per-segment profile that the web
  // renders as AudienceProfilingHero. When the sample segmented (segments !=
  // null), mirror it as a table; aggregate-only reads fall back to the headline.
  if (methodology === 'audience_profiling') {
    const segments = Array.isArray(analysis.segments) ? analysis.segments : [];
    if (segments.length === 0) return null;
    const definingTrait = (s) => {
      const sig = Array.isArray(s.signature) ? s.signature.slice() : [];
      if (sig.length === 0) return '—';
      sig.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      const t = sig[0];
      return `${t.label} (${t.delta >= 0 ? '+' : ''}${t.delta})`;
    };
    return {
      title: 'Audience segments — size and defining trait',
      columns: ['Segment', 'Size', 'n', 'Defining trait (vs. avg)', 'Primary'],
      rows: segments.map((s) => [
        s.name || s.id || 'Segment',
        s.size_pct != null ? `${s.size_pct}%` : '—',
        String(s.n ?? '?'),
        definingTrait(s),
        s.is_primary ? 'Yes' : '',
      ]),
    };
  }

  // §3 export parity — every signature methodology emits its instrument table
  // here (mirroring the web hero), so PDF/PPTX/XLSX carry the same structured
  // read, not just the flat headline. All defensive: missing fields skipped,
  // empty table → null (graceful headline fallback). dnum/dpct are display-only.
  const dnum = (v, dp = 2) => (v == null || !Number.isFinite(Number(v)) ? null : String(Math.round(Number(v) * 10 ** dp) / 10 ** dp));
  const dpct = (v) => (v == null || !Number.isFinite(Number(v)) ? null : `${Math.round(Number(v) * 10) / 10}%`);
  const kvTable = (title, pairs) => {
    const rows = pairs.filter(([, v]) => v != null && v !== '');
    return rows.length ? { title, columns: ['Metric', 'Value'], rows } : null;
  };

  if (methodology === 'pricing') {
    const p = analysis.van_westendorp?.points || {};
    const r = analysis.acceptable_range;
    return kvTable('Price sensitivity — Van Westendorp + Gabor-Granger', [
      ['Optimal price (OPP)', dnum(p.opp)],
      ['Acceptable range', (r && r.low != null && r.high != null) ? `${dnum(r.low)}–${dnum(r.high)}` : null],
      ['Point of marginal cheapness (PMC)', dnum(p.pmc)],
      ['Indifference price (IPP)', dnum(p.ipp)],
      ['Point of marginal expensiveness (PME)', dnum(p.pme)],
      ['Gabor-Granger revenue-optimal', dnum(analysis.gabor_granger?.optimal_price)],
      ['WTP ceiling (mean)', dnum(analysis.wtp_ceiling?.mean)],
    ]);
  }

  if (methodology === 'satisfaction') {
    const nps = analysis.nps || {};
    return kvTable('Satisfaction — NPS · CSAT · CES', [
      ['NPS', dnum(nps.score, 0)],
      ['Promoters', dpct(nps.promoters_pct)],
      ['Passives', dpct(nps.passives_pct)],
      ['Detractors', dpct(nps.detractors_pct)],
      ['CSAT (top-2-box)', dpct(analysis.csat?.top2_pct)],
      ['CES (top-2-box)', dpct(analysis.ces?.top2_pct)],
      ['Retention (mean of 5)', dnum(analysis.retention?.stats?.mean)],
    ]);
  }

  if (methodology === 'roadmap') {
    const feats = (analysis.maxdiff?.features || []).filter((f) => f && f.utility != null);
    if (feats.length === 0) return null;
    const kano = new Map((analysis.kano?.features || []).map((k) => [String(k.feature_id ?? k.label), k.classification]));
    const KANO = { must_be: 'Must-have', performance: 'Performance', attractive: 'Delighter', indifferent: 'Indifferent', reverse: 'Reverse', questionable: 'Questionable' };
    return {
      title: 'Feature priority — MaxDiff utility + Kano class',
      columns: ['Feature', 'MaxDiff utility', 'Kano'],
      rows: feats.slice().sort((a, b) => b.utility - a.utility).map((f) => {
        const cls = kano.get(String(f.feature_id ?? f.label));
        return [f.label || f.feature_id || 'Feature', dnum(f.utility) ?? '—', cls ? (KANO[cls] || cls) : '—'];
      }),
    };
  }

  if (methodology === 'naming') {
    const ladder = analysis.turf?.ladder;
    if (Array.isArray(ladder) && ladder.length) {
      return {
        title: 'Name / tagline reach — TURF',
        columns: ['Add', 'Incremental reach', 'Cumulative reach'],
        rows: ladder.map((s) => [s.option || s.candidate_id || '—', dpct(s.incremental_reach_pct) ?? '—', dpct(s.cumulative_reach_pct) ?? '—']),
      };
    }
    const cands = (analysis.candidates || []).slice().sort((a, b) => {
      const aw = a.pairwise_win_rate?.pct ?? a.composite ?? -Infinity;
      const bw = b.pairwise_win_rate?.pct ?? b.composite ?? -Infinity;
      return bw - aw;
    });
    if (cands.length === 0) return null;
    const winnerId = analysis.winner?.candidate_id;
    return {
      title: 'Name testing — win rate',
      columns: ['Name', 'Win rate', 'Winner'],
      rows: cands.map((c) => [
        c.label || c.candidate_id || 'Name',
        c.pairwise_win_rate?.pct != null ? (dpct(c.pairwise_win_rate.pct) ?? '—')
          : (c.composite != null ? `composite ${dnum(c.composite)}` : '—'),
        c.candidate_id === winnerId ? 'Yes' : '',
      ]),
    };
  }

  if (methodology === 'competitor') {
    const brands = (analysis.brands || []).filter((b) => b && b.preference_pct != null);
    if (brands.length === 0) return null;
    return {
      title: 'Share of preference — focal brand vs competitors',
      columns: ['Brand', 'Preference', 'NPS'],
      rows: brands.slice().sort((a, b) => b.preference_pct - a.preference_pct).map((b) => [
        `${b.label || 'Brand'}${b.is_focal ? ' (focal)' : ''}`,
        dpct(b.preference_pct) ?? '—',
        dnum(b.nps?.score ?? b.nps_score, 0) ?? '—',
      ]),
    };
  }

  if (methodology === 'churn') {
    const drivers = (analysis.drivers?.ranked || []).filter((d) => d && (d.reason || d.option || d.label));
    if (drivers.length === 0 && analysis.winback?.winnable_pct == null) return null;
    const rows = drivers.map((d) => [`Driver: ${d.reason || d.option || d.label}`, dpct(d.pct_of_respondents) ?? '—']);
    if (analysis.winback?.winnable_pct != null) rows.push(['Winnable (would return)', dpct(analysis.winback.winnable_pct) ?? '—']);
    return rows.length ? { title: 'Churn drivers + win-back', columns: ['Factor', '% of churned'], rows } : null;
  }

  if (methodology === 'compare') {
    const concepts = (analysis.concepts || []).filter((c) => c && (c.final_choice_pct?.pct != null || c.dimensions?.appeal?.mean != null));
    if (concepts.length === 0) return null;
    const winnerId = analysis.overall_winner?.concept_id;
    const rows = concepts.map((c) => [
      c.label || c.concept_id || 'Concept',
      c.final_choice_pct?.pct != null ? (dpct(c.final_choice_pct.pct) ?? '—')
        : (c.dimensions?.appeal?.mean != null ? `appeal ${dnum(c.dimensions.appeal.mean)}` : '—'),
      c.concept_id === winnerId ? 'Yes' : '',
    ]);
    if (analysis.final_choice?.none?.pct != null) rows.push(['None of these', dpct(analysis.final_choice.none.pct) ?? '—', '']);
    return { title: 'Head-to-head — forced choice', columns: ['Concept', 'Forced choice', 'Winner'], rows };
  }

  // validate / marketing / research lead with their headline metrics (a few
  // numbers, no per-row structure) — the flat headline carries them.
  return null;
}

function sigLabel(sig) {
  if (!sig) return 'directional';
  if (sig.sig95) return 'significant at 95%';
  if (sig.sig90) return 'significant at 90%';
  return 'directional';
}

module.exports = { buildRenderModel, shapeSurveyBody, pct };
