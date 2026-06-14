/*
 * Pass 49 Phase 3 — dedicated report summary generator.
 *
 * The monolithic synthesizeInsights() reliably fails (narration_failed) on
 * real missions, so every exec summary fell back to a hedged computed string
 * and per_question_insights was empty. This module generates the two
 * audience-facing summaries DIRECTLY from the canonical report, decoupled from
 * the fragile big-blob synthesis:
 *
 *   - executive summary: a grounded multi-sentence narrative
 *   - per-question micro-summaries: a 1-2 sentence "what this means" per Q
 *
 * Design for reliability (this is the headline feature — it must always work):
 *   1. DETERMINISTIC templates, grounded in each question's computed
 *      distribution, are the floor — always present, never hallucinate, free.
 *   2. An LLM pass (grounded in the SAME canonical numbers) enriches the prose
 *      when available; every LLM line is validated against its own question's
 *      data (honesty guard) and falls back to the deterministic line if it
 *      drifts or generation fails.
 *
 * Cached onto insights.executive_summary + insights.per_question_insights at
 * synthesis (and via backfill), so web + exports + chat all read identical
 * static text. NO hedge strings — ever.
 */

const { callClaude } = require('./anthropic');
const logger = require('../../utils/logger');

// ── helpers ───────────────────────────────────────────────────────────────
function pct(n, d) { return d > 0 ? Math.round((n / d) * 100) : 0; }
function clampSentence(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

/** Top entries of a {key: count} distribution, sorted desc. */
function topEntries(dist) {
  return Object.entries(dist || {})
    .map(([k, v]) => [k, Number(v) || 0])
    .sort((a, b) => b[1] - a[1]);
}

/**
 * Deterministic, grounded 1-2 sentence insight for one canonical survey
 * question. Always returns a string (never null) so every question is covered.
 */
function deterministicQuestionInsight(q) {
  const d = q.data || {};
  const r = q.renderer || '';
  try {
    if (r.startsWith('scale_')) {
      const dist = d.distribution || {};
      const n = d.n || Object.values(dist).reduce((s, v) => s + (Number(v) || 0), 0);
      if (!n) return 'No ratings were recorded for this question.';
      const min = d.scale_min ?? 1; const max = d.scale_max ?? 5;
      const avg = d.average;
      // Factual top/bottom box only — NO editorial tone. A "strongly positive"
      // label on a raw 0-10 mean would contradict the methodology metric
      // (e.g. mean 7/10 but NPS = -20). Interpretation is left to the LLM pass,
      // which sees the whole report including the headline.
      const topCount = [max, max - 1].reduce((s, v) => s + (Number(dist[v]) || 0), 0);
      const botCount = [min, min + 1].reduce((s, v) => s + (Number(dist[v]) || 0), 0);
      return clampSentence(`Average ${avg} out of ${max} (n=${n}); ${pct(topCount, n)}% rated it ${max - 1}–${max} and ${pct(botCount, n)}% rated it ${min}–${min + 1}.`);
    }
    if (r === 'multi_select') {
      const base = d.n_respondents || d.n || 0;
      const top = topEntries(d.distribution)[0];
      if (!top || !base) return 'No selections were recorded for this question.';
      return clampSentence(`"${top[0]}" was selected most often — ${pct(top[1], base)}% of ${base} respondents (multi-select).`);
    }
    if (r === 'attribute_battery') {
      if (d.shape === 'matrix' && Array.isArray(d.per_attribute) && d.per_attribute.length) {
        const sorted = [...d.per_attribute].filter((a) => a && a.average != null).sort((a, b) => b.average - a.average);
        if (sorted.length) {
          const hi = sorted[0]; const lo = sorted[sorted.length - 1];
          if (sorted.length === 1) return clampSentence(`"${hi.attribute}" scored ${hi.average} (n=${hi.n}).`);
          return clampSentence(`"${hi.attribute}" scored highest (${hi.average}) and "${lo.attribute}" lowest (${lo.average}).`);
        }
      }
      const top = topEntries(d.distribution)[0];
      if (top) return clampSentence(`"${top[0]}" led on this battery.`);
      return 'No attribute ratings were recorded.';
    }
    if (r === 'max_diff') {
      const best = topEntries(d.best)[0]; const worst = topEntries(d.worst)[0];
      if (best && worst) return clampSentence(`"${best[0]}" was picked best most often; "${worst[0]}" was picked worst most often.`);
      if (best) return clampSentence(`"${best[0]}" was the most-preferred feature.`);
      return 'No best/worst picks were recorded.';
    }
    if (r === 'open_text_verbatims') {
      const items = d.verbatims || [];
      if (!items.length) return 'No open-text responses were recorded.';
      return clampSentence(`${items.length} open-text response${items.length === 1 ? '' : 's'} — read the verbatims for qualitative themes.`);
    }
    // single_select / forced_choice / paired_comparison / screener / kano / choice
    const entries = topEntries(d.distribution);
    const total = entries.reduce((s, [, v]) => s + v, 0);
    if (!entries.length || !total) return 'No responses were recorded for this question.';
    const [opt, count] = entries[0];
    const p = pct(count, total);
    const majority = p >= 50 ? '' : ' — no option reached a majority';
    return clampSentence(`"${opt}" led with ${p}% (${count} of ${total})${majority}.`);
  } catch (e) {
    return 'Responses recorded; see the distribution above.';
  }
}

/**
 * Deterministic, hedge-free executive summary from the canonical report.
 * Multi-sentence, grounded in the headline + key findings + sample posture.
 */
function deterministicExecSummary(report) {
  const parts = [];
  const h = report.headline;
  if (h && h.metric && h.value) parts.push(`${h.metric}: ${h.value}.`);
  // a couple of supporting headline metrics
  const more = (h && Array.isArray(h.all) ? h.all : []).slice(1, 3)
    .filter((m) => m && m.label && m.value && `${m.label}: ${m.value}.` !== parts[0]);
  for (const m of more) parts.push(`${m.label}: ${m.value}.`);
  // key findings
  for (const kf of (report.key_findings || []).slice(0, 2)) {
    const t = typeof kf === 'string' ? kf : (kf && (kf.text || kf.headline || kf.finding));
    if (t) parts.push(clampSentence(t).replace(/\.?$/, '.'));
  }
  const s = report.header && report.header.sample;
  if (s && s.n != null) {
    parts.push(s.posture === 'directional'
      ? `Based on ${s.n} respondents — treat these as directional signal and validate at a larger sample before committing.`
      : `Based on ${s.n} respondents.`);
  }
  return clampSentence(parts.join(' ')) || 'Your computed results below are complete.';
}

// ── LLM enrichment ──────────────────────────────────────────────────────────
function extractJSONObject(text) {
  if (!text) return null;
  const a = text.indexOf('{'); const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

/** Compact, number-bearing tokens from a question's data — for the honesty guard. */
function dataTokens(q) {
  const d = q.data || {}; const toks = new Set();
  const add = (v) => { if (v != null && String(v).trim()) toks.add(String(v).trim().toLowerCase()); };
  if (d.average != null) add(d.average);
  if (d.scale_max != null) add(d.scale_max);
  if (d.n != null) add(d.n);
  for (const k of Object.keys(d.distribution || {})) { add(k); add(d.distribution[k]); }
  for (const a of (d.per_attribute || [])) { add(a.attribute); add(a.average); }
  for (const k of Object.keys(d.best || {})) add(k);
  return [...toks];
}

/** Honesty guard: an LLM insight must reference a real token from its question. */
function referencesData(insight, q) {
  const lc = String(insight || '').toLowerCase();
  if (lc.length < 8) return false;
  // Qualitative questions have no numeric anchor — accept any non-empty prose.
  if (q.renderer === 'open_text_verbatims') return true;
  const toks = dataTokens(q);
  if (!toks.length) return true;
  // Strong signal: an option-label token (>=3 chars) appears verbatim.
  if (toks.some((t) => t.length >= 3 && lc.includes(t))) return true;
  // Numeric tokens (incl. single digits for small-n) — word-boundary match so
  // "5" doesn't spuriously match inside "2025".
  return toks.some((t) => {
    if (!/^-?\d+(\.\d+)?$/.test(t)) return false;
    const esc = t.replace('.', '\\.');
    return new RegExp(`(^|[^\\d.])${esc}([^\\d.]|$)`).test(lc);
  });
}

function compactQuestionForPrompt(q) {
  const d = q.data || {};
  const out = { id: q.id, number: q.number, text: q.text, renderer: q.renderer };
  if (d.average != null) { out.average = d.average; out.scale = `${d.scale_min}-${d.scale_max}`; out.n = d.n; }
  if (d.distribution) out.distribution = d.distribution;
  if (d.per_attribute) out.attributes = d.per_attribute.map((a) => ({ a: a.attribute, avg: a.average }));
  if (d.best) out.best = d.best;
  if (d.worst) out.worst = d.worst;
  if (d.verbatims) out.verbatim_count = d.verbatims.length;
  return out;
}

/**
 * Generate { executive_summary, per_question_insights } for a canonical report.
 * Deterministic floor always wins if the LLM is unavailable or drifts.
 * @param {object} report canonical report (buildCanonicalReport output)
 * @param {object} opts { missionId, userId }
 */
async function generateReportSummaries(report, opts = {}) {
  const survey = Array.isArray(report.survey) ? report.survey : [];

  // 1) Deterministic floor — every question covered, grounded by construction.
  const detPerQ = new Map(survey.map((q) => [q.id, deterministicQuestionInsight(q)]));
  let execSummary = deterministicExecSummary(report);
  let execSource = 'computed';
  const perQSource = new Map(survey.map((q) => [q.id, 'computed']));

  // 2) LLM enrichment (best-effort, grounded, validated).
  const sample = report.header && report.header.sample;
  const posture = sample && sample.posture === 'directional'
    ? `This is a directional sample (n=${sample.n}); carry that caveat — never imply statistical certainty.`
    : '';
  const SYS = `You are VETT's research analyst. Write plain-language summaries grounded ENTIRELY in the figures provided — never invent, estimate, or round differently. ${posture} No hedging, no apologies, no "summary unavailable" language. Lead with the finding. Return ONLY valid JSON.`;

  // 2a) Executive summary
  try {
    const ctx = {
      title: report.header && report.header.title,
      methodology: report.header && report.header.methodology_label,
      headline: report.headline,
      centerpiece: report.centerpiece,
      key_findings: report.key_findings,
      sample,
    };
    const budget = Math.min(1200, Math.max(500, survey.length * 60));
    const res = await callClaude({
      callType: 'report_summary',
      missionId: opts.missionId || null,
      userId: opts.userId || null,
      systemPrompt: SYS,
      maxTokens: budget,
      messages: [{ role: 'user', content:
        `Write a 3-4 sentence executive summary of this research report, grounded only in these figures. State the single most important takeaway first, then 1-2 supporting numbers, then one forward-looking recommendation. Return JSON: {"executive_summary":"..."}\n\n${JSON.stringify(ctx)}` }],
    });
    const obj = extractJSONObject(res.text);
    const txt = obj && typeof obj.executive_summary === 'string' ? clampSentence(obj.executive_summary) : '';
    if (txt && txt.length > 40 && !/unavailable|apolog|as an ai/i.test(txt)) { execSummary = txt; execSource = 'ai'; }
  } catch (e) {
    logger.warn('reportSummaries: exec summary LLM failed; using computed', { missionId: opts.missionId, err: e.message });
  }

  // 2b) Per-question insights (batched, one call)
  if (survey.length) {
    try {
      const compact = survey.map(compactQuestionForPrompt);
      const budget = Math.min(4000, Math.max(800, survey.length * 120));
      const res = await callClaude({
        callType: 'report_summary',
        missionId: opts.missionId || null,
        userId: opts.userId || null,
        systemPrompt: SYS,
        maxTokens: budget,
        messages: [{ role: 'user', content:
          `For EACH question below, write a 1-2 sentence "what this means" grounded only in that question's numbers (cite a figure). Return JSON mapping question id to the sentence: {"<id>":"...", ...}\n\n${JSON.stringify(compact)}` }],
      });
      const obj = extractJSONObject(res.text) || {};
      for (const q of survey) {
        const cand = typeof obj[q.id] === 'string' ? clampSentence(obj[q.id]) : '';
        if (cand && cand.length > 12 && !/unavailable|apolog|as an ai/i.test(cand) && referencesData(cand, q)) {
          detPerQ.set(q.id, cand);
          perQSource.set(q.id, 'ai');
        }
      }
    } catch (e) {
      logger.warn('reportSummaries: per-question LLM failed; using computed', { missionId: opts.missionId, err: e.message });
    }
  }

  const per_question_insights = survey.map((q) => ({
    question_id: q.id,
    number: q.number,
    insight: detPerQ.get(q.id),
    source: perQSource.get(q.id),
  }));

  return { executive_summary: execSummary, exec_summary_source: execSource, per_question_insights };
}

module.exports = {
  generateReportSummaries,
  deterministicQuestionInsight,
  deterministicExecSummary,
  referencesData,
};
