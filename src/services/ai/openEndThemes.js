/*
 * Pass 50 P2-1 — open-end theme clustering.
 *
 * Open-ended (free-text) questions had no visual: the report silently fell back
 * to "see verbatims", so a 5-question survey showed only 4 charts. This module
 * clusters a text question's verbatim answers into 3-6 named themes, each with a
 * frequency count, a sentiment, and 1-2 representative quotes — turning the
 * open-end into a real visual block (horizontal theme-frequency bars) that web
 * and every export render identically (cached onto insights.open_end_themes,
 * read by buildCanonicalReport).
 *
 * Grounded by construction: counts are clamped to the sample, sentiment is
 * validated, and a quote is KEPT ONLY IF it is a (normalized) substring of a
 * real answer — a paraphrased/invented quote is dropped rather than shown. If
 * the LLM is unavailable or there are too few answers to cluster, it returns no
 * themes and the caller renders verbatims as before (never throws).
 */

const { callClaude } = require('./anthropic');
const logger = require('../../utils/logger');

const MIN_TO_CLUSTER = 3; // fewer answers than this → just show verbatims
const MAX_THEMES = 6;

function extractJSONObject(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/** Normalize for grounding comparison: lowercase, collapse whitespace, unify quotes. */
function norm(s) {
  return String(s || '').toLowerCase().replace(/[“”‘’]/g, '"').replace(/\s+/g, ' ').trim();
}

/**
 * Cluster a text question's verbatims into themes.
 * @param {{id:string,text:string}} question
 * @param {string[]} verbatims  raw answer strings (already capped by the caller)
 * @param {{missionId?:string,userId?:string}} opts
 * @returns {Promise<{themes:Array<{label,count,pct,sentiment,quotes:string[]}>, n:number}>}
 */
async function clusterOpenEndThemes(question, verbatims, opts = {}) {
  const clean = (verbatims || [])
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean);
  const n = clean.length;
  if (n < MIN_TO_CLUSTER) return { themes: [], n };

  try {
    const res = await callClaude({
      callType: 'report_summary',
      missionId: opts.missionId || null,
      userId: opts.userId || null,
      systemPrompt:
        'You are a qualitative research analyst. Cluster verbatim open-ended answers into themes grounded ENTIRELY in the answers provided — never invent a theme, a count, or a quote. Return ONLY valid JSON.',
      maxTokens: 1300,
      messages: [{
        role: 'user',
        content:
          `Question: "${question.text}"\n\n` +
          `Cluster these ${n} verbatim answers into 3-6 distinct themes. For EACH theme return ` +
          `{"label": a 2-5 word name, "count": how many of the ${n} answers express it (integer 1-${n}), ` +
          `"sentiment": one of "positive"|"neutral"|"negative", ` +
          `"quotes": 1-2 quotes copied EXACTLY (verbatim, character-for-character) from the answers}. ` +
          `Order themes by count descending. Return ONLY {"themes":[...]}.\n\n` +
          `ANSWERS:\n${clean.map((v, i) => `${i + 1}. ${v}`).join('\n')}`,
      }],
    });

    const obj = extractJSONObject(res.text) || {};
    if (!Array.isArray(obj.themes)) return { themes: [], n };

    const themes = obj.themes
      .filter((t) => t && t.label && Number.isFinite(Number(t.count)))
      .slice(0, MAX_THEMES)
      .map((t) => {
        const count = Math.max(1, Math.min(n, Math.round(Number(t.count))));
        const quotes = (Array.isArray(t.quotes) ? t.quotes : [])
          .map((q) => String(q || '').trim())
          .map((q) => q.replace(/^["“”']+|["“”']+$/g, '').trim())
          // Grounding: keep only quotes that are a real substring of some answer.
          .filter((q) => {
            const nq = norm(q);
            return nq.length >= 8 && clean.some((v) => norm(v).includes(nq));
          })
          .slice(0, 2);
        return {
          label: String(t.label).trim().slice(0, 60),
          count,
          pct: Math.round((count / n) * 100),
          sentiment: ['positive', 'negative', 'neutral'].includes(t.sentiment) ? t.sentiment : 'neutral',
          quotes,
        };
      })
      .filter((t) => t.label)
      .sort((a, b) => b.count - a.count);

    return { themes, n };
  } catch (e) {
    logger.warn('openEndThemes: clustering failed; verbatims only', { qid: question.id, err: e.message });
    return { themes: [], n };
  }
}

module.exports = { clusterOpenEndThemes, MIN_TO_CLUSTER };
