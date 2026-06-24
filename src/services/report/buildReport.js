/**
 * Pass 48 — THE CANONICAL REPORT.
 *
 * One report model that the web results page, every export builder, AND
 * the results-page chatbot consume. Built once, server-side, from a
 * completed mission + its computed `analysis` (Pass 46 Phase 3, CORRECT —
 * never recomputed here) + its mission_responses. Because all surfaces
 * read this single object they can no longer disagree (the Pass-48 root
 * cause: web / export / chat were three separate renderings).
 *
 * The defining fix is the per-question RENDERER REGISTRY: every question
 * is assigned a `renderer` from its type + options + metadata, and its
 * `data` is shaped correctly for THAT renderer. No question may fall back
 * to the 1-5 star widget unless it is genuinely a 1-5 scale — which kills
 * the "7/5" (0-10 through a 5-star widget) and "0/5" (1-7 / attribute
 * battery collapsing to empty 1-5 buckets) bug class at the source.
 */

const { computeRatingStats } = require('../ai/insights');
const { analysisHeadlines } = require('../exports/analysisHeadlines');
const { computeStatGate } = require('./statGate');
const { deriveFocalBrand, isGeneric } = require('../../utils/focalBrand');
const { computePersonas } = require('../analysis/personas');

const VERBATIM_CAP = 30;

const METHODOLOGY_LABELS = {
  validate: 'Product Validation', compare: 'Concept Comparison', marketing: 'Ad Effectiveness',
  satisfaction: 'Customer Satisfaction', pricing: 'Pricing Study', roadmap: 'Feature Roadmap',
  research: 'Market Research', competitor: 'Competitor Analysis', naming_messaging: 'Naming & Messaging',
  churn_research: 'Churn Study', brand_lift: 'Brand Lift Study', creative_attention: 'Creative Attention',
};

/** Numeric coercion: null for non-numbers (incl. ''/null). */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pass 48 Phase 3 — numeric coercion for SCALE ANSWERS specifically.
 * Synthetic respondents often answer a numeric scale with the LABELLED
 * option text ("3 - Neutral", "5 - Very likely", "4: Likely") rather than
 * the bare number. Plain num() returns null for those, which collapsed the
 * scale to an empty distribution → "Average 0 / 5 (n=0)" — the exact "0/5"
 * bug class. This extracts the LEADING integer from such labels so the
 * scale renders its real distribution + mean. Falls back to strict num()
 * for anything without a leading number, and never extracts a number from
 * the MIDDLE of a label (e.g. "Buy 2 get 1" stays null, not 2).
 */
function scaleNum(v) {
  const n = num(v);
  if (n !== null) return n;
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(-?\d+(?:\.\d+)?)\s*(?:[-–—:.)]|\s)/);
  if (m) {
    const parsed = Number(m[1]);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Derive {min,max} numeric scale from a question's options; null when not numeric. */
function numericScale(options) {
  if (!Array.isArray(options) || options.length === 0) return null;
  const nums = options.map((o) => num(o)).filter((v) => v !== null);
  if (nums.length < 2 || nums.length !== options.length) return null; // mixed/labelled options aren't a numeric scale
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

/**
 * Pass 48 — ROBUST scale detection. Real NPS/CES questions often carry
 * EMPTY options with the scale stated only in the text ("on a scale of 0
 * to 10"), so options alone aren't enough — relying on them is exactly
 * why NPS rendered as "7/5". Resolve the scale from, in priority:
 *   1. numeric options (["0".."10"])
 *   2. question metadata (methodology/funnel_stage = nps → 0-10, ces → 1-7)
 *   3. the text ("scale of 0 to 10", "1 to 7", "1-5")
 *   4. observed answers (a max > 5 can NEVER be a 1-5 star scale)
 * The observed-answer max always WIDENS the scale so an average can never
 * land outside its own buckets (no "7/5").
 */
function detectScale(q, numericAnswers) {
  let scale = numericScale(q.options);

  if (!scale) {
    const meta = `${q.methodology || ''} ${q.funnel_stage || ''} ${q.kpi_category || ''}`.toLowerCase();
    const text = String(q.text || '').toLowerCase();
    if (meta.includes('nps') || /scale of 0\s*(?:to|[-–])\s*10|0\s*[-–]\s*10\b|0 to 10/.test(text)) {
      scale = { min: 0, max: 10 };
    } else if (meta.includes('ces') || /1\s*(?:to|[-–])\s*7\b|scale of 1 to 7/.test(text)) {
      scale = { min: 1, max: 7 };
    } else {
      const m = text.match(/(\d+)\s*(?:to|[-–])\s*(\d+)/);
      if (m) scale = { min: Number(m[1]), max: Number(m[2]) };
    }
  }

  if (!scale) scale = { min: 1, max: 5 }; // native default

  // Observed answers are ground truth — never let the average exceed its
  // buckets. If a value sits outside the inferred scale, widen to fit.
  const nums = (numericAnswers || []).filter((v) => v !== null && v !== undefined);
  if (nums.length) {
    const lo = Math.min(...nums); const hi = Math.max(...nums);
    if (lo < scale.min) scale.min = Math.min(scale.min, Math.floor(lo));
    if (hi > scale.max) {
      // snap up to the nearest canonical ceiling so a 0-10 with max 9
      // still reads as 0-10, not 0-9.
      scale.max = hi > 7 ? 10 : hi > 5 ? 7 : Math.ceil(hi);
    }
  }
  return scale;
}

function rendererForScale(scale) {
  if (scale.min === 0 && scale.max === 10) return 'scale_0_10';
  if (scale.min === 1 && scale.max === 7) return 'scale_1_7';
  if (scale.min >= 1 && scale.max <= 5) return 'scale_1_5_star';
  return 'scale_generic';
}

/**
 * THE RENDERER REGISTRY — question → renderer enum. Single source of
 * truth used (via the produced `renderer` field) by web + exports + chat.
 */
function pickRenderer(q, numericAnswers) {
  if (q.isScreening) return 'screener';
  if (q.type === 'max_diff_set') return 'max_diff';
  if (q.methodology === 'kano' || q.kano_type) return 'kano';
  // attribute_matrix is a rating-style battery (one Q rating many items) —
  // it must NOT go through a single scalar scale renderer (that's the
  // satisfaction Q8 "0/5 n=0" bug). Catch it before the scale branch.
  if (q.methodology === 'attribute_matrix') return 'attribute_battery';
  if (q.is_paired_comparison) return 'paired_comparison';
  if (q.is_final_choice) return 'forced_choice';
  if (q.type === 'text' || q.type === 'open') return 'open_text_verbatims';
  if (q.type === 'multi') {
    if (q.brand_id || q.funnel_stage === 'attributes') return 'attribute_battery';
    return 'multi_select';
  }
  if (q.type === 'single' || q.type === 'opinion') return 'single_select';
  if (q.type === 'rating' || q.type === 'nps' || q.type === 'scale') {
    return rendererForScale(detectScale(q, numericAnswers));
  }
  return Array.isArray(q.options) && q.options.length ? 'single_select' : 'open_text_verbatims';
}

/** Counts distribution {answer: count} over scalar answers. */
function countDistribution(answers) {
  const dist = {};
  for (const a of answers) {
    if (a === null || a === undefined) continue;
    const values = Array.isArray(a) ? a : [a];
    for (const v of values) {
      const k = String(v);
      dist[k] = (dist[k] || 0) + 1;
    }
  }
  return dist;
}

/**
 * Shape a question's data for its renderer. The scale renderers build a
 * distribution over the question's TRUE bucket range (0-10, 1-7, 1-5, or
 * generic min..max) — never the hardcoded 1-5 of aggregate().
 */
function shapeQuestionData(q, renderer, responses, analysis) {
  const answers = responses.filter((r) => r.question_id === q.id).map((r) => r.answer);
  const n = answers.length;

  if (renderer.startsWith('scale_')) {
    const nums = answers.map((a) => scaleNum(a)).filter((v) => v !== null);
    const scale = detectScale(q, nums);
    const buckets = {};
    for (let i = scale.min; i <= scale.max; i += 1) buckets[i] = 0;
    for (const v of nums) if (buckets[v] !== undefined) buckets[v] += 1;
    const stats = computeRatingStats(nums);
    return {
      scale_min: scale.min, scale_max: scale.max,
      distribution: buckets, average: stats.avg, n: nums.length,
      ci_low: stats.ci_low, ci_high: stats.ci_high, stddev: stats.stddev,
    };
  }

  if (renderer === 'open_text_verbatims') {
    const verbatims = answers
      .map((a) => (typeof a === 'string' ? a.trim() : null))
      .filter(Boolean).slice(0, VERBATIM_CAP);
    return { verbatims, n };
  }

  if (renderer === 'attribute_battery') {
    // Two shapes: (a) per-attribute object answers {attr: rating} → per-
    // attribute averages; (b) multi-select of attribute names → endorsement
    // counts. Detect and shape both so it never collapses to "0/5".
    const objAnswers = answers.filter((a) => a && typeof a === 'object' && !Array.isArray(a));
    if (objAnswers.length > 0) {
      const sums = {}; const counts = {};
      for (const obj of objAnswers) {
        for (const [attr, val] of Object.entries(obj)) {
          const v = num(val);
          if (v === null) continue;
          sums[attr] = (sums[attr] || 0) + v;
          counts[attr] = (counts[attr] || 0) + 1;
        }
      }
      const per_attribute = Object.keys(sums).map((attr) => ({
        attribute: attr, average: Math.round((sums[attr] / counts[attr]) * 100) / 100, n: counts[attr],
      }));
      // Pass 49 polish — carry the battery's true scale ceiling so renderers
      // fill bars over the real max (not a hardcoded /5) for 1-7 / 0-10 matrices.
      const allVals = objAnswers.flatMap((obj) => Object.values(obj).map((v) => num(v)).filter((v) => v !== null));
      const scale_max = detectScale(q, allVals).max;
      return { per_attribute, n: objAnswers.length, shape: 'matrix', scale_max };
    }
    return { distribution: countDistribution(answers), n_respondents: n, n, shape: 'endorsement' };
  }

  if (renderer === 'multi_select') {
    return { distribution: countDistribution(answers), n_respondents: n, n };
  }

  if (renderer === 'max_diff') {
    // best/worst counts per option from {best,worst} answers.
    const best = {}; const worst = {};
    for (const a of answers) {
      if (a && typeof a === 'object' && !Array.isArray(a)) {
        if (a.best != null) best[String(a.best)] = (best[String(a.best)] || 0) + 1;
        if (a.worst != null) worst[String(a.worst)] = (worst[String(a.worst)] || 0) + 1;
      }
    }
    return { best, worst, n, feature_set: q.feature_set || null };
  }

  // single_select / forced_choice / paired_comparison / screener / kano
  return { distribution: countDistribution(answers), n };
}

/** Plain-language renderer label for the survey appendix. */
const RENDERER_LABELS = {
  scale_0_10: '0-10 scale', scale_1_7: '1-7 scale', scale_1_5_star: '1-5 rating',
  scale_generic: 'numeric scale', single_select: 'single choice', multi_select: 'multi-select',
  attribute_battery: 'attribute battery', forced_choice: 'forced choice',
  paired_comparison: 'paired comparison', max_diff: 'MaxDiff (best/worst)', kano: 'Kano',
  open_text_verbatims: 'open text', screener: 'screener',
};

/**
 * Pass 48 — cleaned data-quality notes. ONE note per question maximum.
 * Suppresses the false-positive "answer choices overlap" heuristic for
 * graded scales (Likert / intent ladder / CSAT / CES are SUPPOSED to have
 * adjacent options). Keeps genuine signals: option drift (an answer not in
 * the saved option list) and empty-data on a delivered question.
 */
function buildDataQualityNotes(survey, responses) {
  const notes = [];
  for (const q of survey) {
    if (q.renderer === 'open_text_verbatims' || q.renderer === 'max_diff' || q.renderer === 'kano') continue;
    const optionSet = new Set((q.options || []).map((o) => String(o).trim().toLowerCase()));
    if (optionSet.size === 0) continue;
    const answers = responses.filter((r) => r.question_id === q.id).map((r) => r.answer);
    // Option drift: a scalar answer that isn't one of the saved options.
    const drift = new Set();
    for (const a of answers) {
      const values = Array.isArray(a) ? a : [a];
      for (const v of values) {
        if (v === null || v === undefined) continue;
        if (typeof v === 'object') continue;
        const norm = String(v).trim().toLowerCase();
        if (norm && !optionSet.has(norm) && !q.renderer.startsWith('scale_')) drift.add(String(v));
      }
    }
    if (drift.size > 0) {
      notes.push({
        question_number: q.number,
        question_id: q.id,
        note: `${drift.size} answer value(s) not in the saved option list (${[...drift].slice(0, 3).join(', ')}${drift.size > 3 ? '…' : ''}).`,
      });
    }
  }
  return notes;
}

const DISCLAIMER =
  'Results are generated by AI synthetic respondents calibrated to the audience spec. They are directional signal, not a substitute for fielding with real customers — especially at small sample sizes. Combine with real-customer data before making absolute claims.';

/**
 * Build the canonical report.
 * @param {object} mission   full mission row (incl. analysis, insights, questions, brief…)
 * @param {object} analysis  mission.analysis (deterministic methodology analysis)
 * @param {Array}  responses clean mission_responses rows ({question_id, answer, persona_id, …})
 * @returns {object} CanonicalReport
 */
function buildCanonicalReport(mission, analysis, responses) {
  const questions = Array.isArray(mission.questions) ? mission.questions : [];
  const rows = Array.isArray(responses) ? responses : [];

  // creative_attention keeps its signature in mission.creative_analysis — a
  // vision analysis of the creative — NOT the survey `analysis` (null for CA).
  // Surface it as the headline + centerpiece + narrative source so the SHARED
  // canonical exporters (PDF/PPTX) render the real creative read, at parity with
  // CA's bespoke web page + XLSX, instead of falling back to an empty headline.
  const creativeCA = (mission.goal_type === 'creative_attention'
    && mission.creative_analysis && typeof mission.creative_analysis === 'object')
    ? mission.creative_analysis
    : null;
  if (creativeCA && (!analysis || typeof analysis !== 'object')) {
    analysis = { methodology: 'creative_attention', ...creativeCA };
  }
  const caSummary = (creativeCA && creativeCA.summary && typeof creativeCA.summary === 'object')
    ? creativeCA.summary : {};

  // §2.3 safety net at RENDER time — legacy competitor missions baked the literal
  // "Our Brand" placeholder into THREE stored places: the analysis (focal_brand +
  // the focal brand's row), the survey question text + answer labels (e.g.
  // "recommend Our Brand to a friend"), and the insights (a KPI value + a rec).
  // The §2.3 fix only sanitised at analysis-GENERATION, so stored missions still
  // leak it on every surface. Resolve a real focal label and scrub the placeholder
  // from every rendered string (via cleanText / scrubKpi / DQ-notes below).
  //
  //  GUARD (a) — engage ONLY when the focal brand was never properly captured
  //    (the stored focal is a generic placeholder or unset). When a REAL brand is
  //    on file, every string already uses it, so we leave them ALL untouched and
  //    never rewrite an incidental "your brand"/"our company" inside a genuine
  //    respondent verbatim.
  //  GUARD (b) — the regex matches the placeholder as a WHOLE token (\b…\s+…\b):
  //    it cannot eat "your"/"company" embedded in a longer word ("accompany",
  //    "yourself") or anywhere the two tokens aren't adjacent.
  // Clone, never mutate the loaded analysis. (compare is concept-based — no focal.)
  let focalScrubRe = null;
  let focalReal = null;
  if (mission.goal_type === 'competitor' && analysis && typeof analysis === 'object') {
    const storedFocal = String(analysis.focal_brand || mission.brand_name || '').trim();
    const focalUnresolved = storedFocal === '' || isGeneric(storedFocal);
    if (focalUnresolved) {
      focalReal = deriveFocalBrand(storedFocal, mission.brief || mission.mission_statement);
      focalScrubRe = /\b(?:our|your|my)\s+(?:brand|company)\b/gi;
      analysis = {
        ...analysis,
        focal_brand: isGeneric(analysis.focal_brand) ? focalReal : analysis.focal_brand,
        brands: Array.isArray(analysis.brands)
          ? analysis.brands.map((b) => ((b && (b.is_focal || b.isFocal) && isGeneric(b.label)) ? { ...b, label: focalReal } : b))
          : analysis.brands,
      };
    }
  }

  // Pass 49 — per-question micro-summaries, generated once at synthesis and
  // cached on insights.per_question_insights, attached to each survey question
  // so web + exports + chat render identical "what this means" text.
  const insights = (mission.insights && typeof mission.insights === 'object') ? mission.insights : {};
  const pqiMap = new Map(
    (Array.isArray(insights.per_question_insights) ? insights.per_question_insights : [])
      .filter((p) => p && p.question_id)
      .map((p) => [p.question_id, typeof p === 'string' ? p : (p.insight || p.body || p.headline || null)]));

  // P2-1 — cached open-end theme clusters, keyed by question_id, attached to
  // each text question so the open-end renders as a visual (theme bars) on
  // every surface instead of punting to verbatims.
  const themesMap = new Map(
    insights.open_end_themes && typeof insights.open_end_themes === 'object'
      ? Object.entries(insights.open_end_themes)
        .filter(([, v]) => v && Array.isArray(v.themes) && v.themes.length)
        .map(([qid, v]) => [qid, v.themes])
      : []);

  // ── survey: every question, correct renderer + correctly-shaped data ──
  const survey = questions.map((q, i) => {
    // Observed numeric answers inform scale detection (NPS/CES often carry
    // empty options — the scale lives in the answers + text).
    const numericAnswers = rows
      .filter((r) => r.question_id === q.id)
      .map((r) => scaleNum(r.answer))
      .filter((v) => v !== null);
    const renderer = pickRenderer(q, numericAnswers);
    const data = shapeQuestionData(q, renderer, rows, analysis);
    if (renderer === 'open_text_verbatims' && themesMap.has(q.id)) {
      data.themes = themesMap.get(q.id);
    }
    return {
      number: i + 1,
      id: q.id,
      text: q.text || '',
      type: q.type || null,
      renderer,
      renderer_label: RENDERER_LABELS[renderer] || renderer,
      options: q.options || [],
      isScreening: !!q.isScreening,
      data,
      insight: pqiMap.get(q.id) || null,
    };
  });

  const headlines = analysisHeadlines(analysis);
  // Pass 48 — drop the Pass-47 hedge tail ("A fuller written narrative was
  // unavailable…") from any computed-fallback summary; surfaces show a
  // clean computed summary with no apology.
  // §A1 — collapse space-before-punctuation (" ," → "," / " ." → ".") and runs
  // of spaces on every rendered string, at the ONE canonical layer so web + PDF
  // + PPTX + XLSX are all clean. (Synthetic-respondent / LLM prose carried a
  // stray space before commas — visible across the live PDF.)
  const cleanText = (s) => {
    if (typeof s !== 'string') return s;
    let out = s.replace(/\s+([,.;:!?])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
    // §2.3 — replace the "Our Brand"/"Your Brand"/… focal placeholder with the
    // resolved focal label on every rendered string (competitor only).
    if (focalScrubRe && focalReal) out = out.replace(focalScrubRe, focalReal);
    return out;
  };
  // §2.3 — focal scrub for KPIs (not routed through cleanText). No-op for
  // non-competitor missions, so existing key_findings are byte-for-byte unchanged.
  const scrubKpi = (k) => {
    if (!focalScrubRe || !focalReal) return k;
    if (typeof k === 'string') return k.replace(focalScrubRe, focalReal);
    if (!k || typeof k !== 'object') return k;
    const out = { ...k };
    for (const f of ['title', 'headline', 'label', 'value', 'description', 'body']) {
      if (typeof out[f] === 'string') out[f] = out[f].replace(focalScrubRe, focalReal);
    }
    return out;
  };

  let execSummary = typeof insights.executive_summary === 'string' && insights.executive_summary
    ? insights.executive_summary
    // CA has no survey-synthesis insights; its narrative lives in the creative
    // analysis summary (benchmark verdict, then attention arc).
    : (creativeCA ? (caSummary.vs_benchmark || caSummary.attention_arc || '') : '');
  execSummary = cleanText(execSummary.replace(/\s*A fuller written narrative was unavailable for this run[.;]?.*$/i, '')) || '';

  const distinctPersonas = new Set(rows.map((r) => r.persona_id).filter(Boolean)).size;

  // §3 — hero "finding": the single punchy takeaway that leads the report.
  // Deterministic floor = the first sentence of the executive summary; falls
  // back to the top headline metric. (A generator may enrich this on prod.)
  const firstSentence = (s) => {
    const m = String(s || '').trim().match(/^[\s\S]*?[.!?](?=\s|$)/);
    return (m ? m[0] : String(s || '')).trim();
  };
  const finding = cleanText(execSummary
    ? firstSentence(execSummary)
    : (headlines.length ? `${headlines[0].label}: ${headlines[0].value}` : null));

  // §A1 — clean EVERY rendered string on the survey: question text, option
  // labels, distribution keys (bar labels), insight, open-end themes, verbatims.
  for (const q of survey) {
    if (q.text) q.text = cleanText(q.text);
    if (Array.isArray(q.options)) q.options = q.options.map(cleanText);
    if (q.insight) q.insight = cleanText(q.insight);
    const d = q.data || {};
    if (d.distribution && typeof d.distribution === 'object' && !Array.isArray(d.distribution)) {
      d.distribution = Object.fromEntries(Object.entries(d.distribution).map(([k, v]) => [cleanText(k), v]));
    }
    if (Array.isArray(d.themes)) {
      d.themes = d.themes.map((t) => ({ ...t, label: cleanText(t.label), quotes: Array.isArray(t.quotes) ? t.quotes.map(cleanText) : t.quotes }));
    }
    if (Array.isArray(d.verbatims)) d.verbatims = d.verbatims.map(cleanText);
  }

  // §3 — screener funnel data. Screened-out respondents are NOT persisted, so we
  // never fabricate a screened-out count; we surface the qualified denominator
  // honestly plus the screener's own answer distribution (shown, not hidden).
  const screenerQ = survey.find((q) => q.isScreening || q.renderer === 'screener');
  const screening = screenerQ ? {
    question_id: screenerQ.id,
    question: screenerQ.text,
    qualified: distinctPersonas || (mission.qualified_respondent_count ?? null),
    distribution: (screenerQ.data && screenerQ.data.distribution) || {},
  } : null;

  return {
    schema_version: 1,
    header: {
      title: cleanText(mission.title) || 'Untitled mission',
      brief: cleanText(mission.brief || mission.mission_statement || ''),
      methodology: mission.goal_type || null,
      methodology_label: METHODOLOGY_LABELS[mission.goal_type] || 'Research Study',
      sample: {
        n: distinctPersonas || (analysis && analysis.n) || null,
        qualified: mission.qualified_respondent_count ?? null,
        delivered: mission.delivered_respondent_count ?? null,
        posture: (distinctPersonas && distinctPersonas < 30) ? 'directional' : 'indicative',
        completed_at: mission.completed_at || null,
        mission_id: mission.id,
      },
    },
    headline: headlines.length > 0
      ? { metric: headlines[0].label, value: headlines[0].value, all: headlines }
      : null,
    centerpiece: analysis && typeof analysis === 'object'
      ? {
        methodology: analysis.methodology || mission.goal_type,
        data: analysis,
        // §2.4 — statistical-integrity gate, attached once at the canonical layer
        // so web + all exports render the SAME honesty verdict and none headline
        // a degenerate figure (e.g. an OPP from n=5).
        // CA is a vision analysis, not a survey — its confidence concept is
        // channel-norm benchmarking, not respondent n; skip the survey stat gate.
        gate: mission.goal_type === 'creative_attention' ? null : computeStatGate(
          analysis.methodology || mission.goal_type,
          analysis,
          distinctPersonas || analysis.n || null,
        ),
      }
      : null,
    key_findings: (Array.isArray(insights.kpis) && insights.kpis.length)
      ? insights.kpis.map(scrubKpi)
      // CA: surface the creative's strengths + watch-outs as the key findings.
      : (creativeCA ? [
        ...(Array.isArray(caSummary.strengths) ? caSummary.strengths.map((t) => `Strength — ${t}`) : []),
        ...(Array.isArray(caSummary.weaknesses) ? caSummary.weaknesses.map((t) => `Watch-out — ${t}`) : []),
      ] : []),
    // B1 — recommendations in the canonical report so web + exports + chat all
    // render the SAME list (was rendered per-page from insights only).
    recommendations: ((Array.isArray(insights.recommendations) && insights.recommendations.length)
      ? insights.recommendations
      // CA: the creative analysis carries its own action list.
      : (creativeCA && Array.isArray(caSummary.recommendations) ? caSummary.recommendations : []))
      .map((r) => (typeof r === 'string' ? r : (r && (r.text || r.recommendation || r.body || r.title)) || ''))
      .map(cleanText)
      .filter((r) => r && r.trim()),
    // §3 — the hero finding (one-liner) + synthesis (the editorial paragraph the
    // mockup leads with). synthesis is the exec summary; web/exports render it as
    // the "VETT synthesis" block.
    finding: finding || null,
    synthesis: execSummary || null,
    // §8 — "who responded" personas. Prefer the persisted insights.personas
    // (written at synthesis); fall back to a deterministic compute from the rows
    // so existing missions (insights.personas empty) still render personas when
    // their responses carry profiles. Empty → section hidden on every surface.
    personas: (Array.isArray(insights.personas) && insights.personas.length)
      ? insights.personas
      : computePersonas(rows, mission),
    screening,
    exec_summary: execSummary || null,
    survey,
    // §2.3 — a data-quality note can quote a raw answer value ("…not in the
    // saved option list (Our Brand)") — scrub the focal placeholder there too.
    data_quality_notes: buildDataQualityNotes(survey, rows)
      .map((n) => ((focalScrubRe && focalReal && n && typeof n.note === 'string')
        ? { ...n, note: n.note.replace(focalScrubRe, focalReal) } : n)),
    methodology_disclaimer: DISCLAIMER,
  };
}

module.exports = {
  buildCanonicalReport,
  pickRenderer,
  shapeQuestionData,
  numericScale,
  detectScale,
  scaleNum,
  buildDataQualityNotes,
  RENDERER_LABELS,
};
