/**
 * Pass 46 Phase 3 — deterministic pricing analysis:
 * Van Westendorp (Price Sensitivity Meter) + Gabor-Granger.
 *
 * Doctrine: the LLM does NOT compute methodology math. Every number the
 * pricing report shows is computed here, deterministically, from clean
 * mission_responses rows. The narrator LLM only writes prose ABOUT the
 * object this module returns. Never throws; incomputable → null.
 *
 * Question metadata this module keys on — quoted from the generator
 * prompt PRICING_SURVEY_GEN_SYSTEM in src/services/claudeAI.js:
 *   L592  "methodology": "screener|van_westendorp|gabor_granger|wtp_ceiling|switching_cost|behavior"
 *   L593  "vw_band": "too_expensive|expensive|bargain|too_cheap"
 *   L594  "gg_anchor_index": 0            (0-4, one per GG ladder rung)
 *   L595  "currency": "USD"
 *   L609  "All 4 VW questions are open-numeric (type=\"text\"; the
 *          frontend will validate numeric input)."
 *   L615  "All 5 GG questions are type=\"single\" with options
 *          [\"Definitely would buy\",\"Probably would buy\",\"Might buy\",
 *           \"Probably would NOT buy\",\"Definitely would NOT buy\"].
 *          Each carries gg_anchor_index 0-4 and the price text is
 *          \"At <currency_symbol><price>, would you ...\""
 *          → the GG anchor price lives IN THE QUESTION TEXT (the
 *          generator JSON schema L583-596 has NO explicit price field),
 *          so we parse it from q.text, preferring a currency-symbol-
 *          anchored number. Explicit fields (gg_price / anchor_price /
 *          price) are honoured first if a future generator adds them.
 *   L618  WTP ceiling (q12) is type="text" open-numeric,
 *          methodology="wtp_ceiling".
 *   L620  "currency MUST be set on every VW + GG + WTP question to the
 *          ISO 4217 code from the user message (default USD if absent)."
 *
 * Answer shapes — quoted from the simulator prompt in
 * src/services/ai/simulate.js:
 *   L47  '"single" / "opinion" → pick ONE option from the provided options'
 *         → GG answers are one of the 5 option strings above.
 *   L50  '"text" → 1-3 sentences in the persona\'s voice (free text)'
 *         → VW / WTP answers may arrive as prose containing a price
 *           ("I'd say around $40"), or formatted ("$1,299.99"), hence
 *           parsePrice() below.
 */

const {
  num,
  byQuestion,
  ratingStats,
  curveIntersection,
  round4,
  personaCount,
} = require('./shared');

const VW_BANDS = ['too_cheap', 'bargain', 'expensive', 'too_expensive'];

// claudeAI.js L615 options, lowercased for case-insensitive matching.
// Demand = top-2-box ("Definitely would buy" + "Probably would buy") —
// the standard Gabor-Granger purchase-intent rule; "Might buy" does NOT
// count as demand.
const GG_OPTIONS = new Set([
  'definitely would buy',
  'probably would buy',
  'might buy',
  'probably would not buy',
  'definitely would not buy',
]);
const GG_AFFIRMATIVE = new Set(['definitely would buy', 'probably would buy']);

/**
 * Robust price parser. Numbers pass through; strings are stripped of
 * thousands-separator commas, then the FIRST numeric token is taken
 * (currency symbols / words around it are ignored). Deterministic:
 * "I'd pay between 40 and 60" → 40. No parseable number → null.
 */
function parsePrice(v) {
  const direct = num(v);
  if (direct !== null) return direct;
  if (typeof v !== 'string') return null;
  const m = v.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/**
 * GG anchor price for one question. Explicit fields win (defensive —
 * not in today's generator schema), else parse the question text per
 * claudeAI.js L615 ("At <currency_symbol><price>, would you ...").
 * A currency-symbol-anchored number is preferred so a product name
 * containing digits can't shadow the price.
 */
function ggAnchorPrice(q) {
  for (const f of [q.gg_price, q.anchor_price, q.price]) {
    const v = num(f);
    if (v !== null) return v;
  }
  if (typeof q.text === 'string') {
    const sym = q.text.replace(/,/g, '').match(/[$€£¥]\s*(\d+(?:\.\d+)?)/);
    if (sym) return Number(sym[1]);
    return parsePrice(q.text);
  }
  return null;
}

/**
 * Van Westendorp block. Complete cases only: a respondent enters the
 * curves only with all 4 parseable band answers, so all four curves
 * share one honest base n. Curves are built on the grid of ALL stated
 * prices (union across the 4 bands, complete cases only):
 *   curve_too_cheap(p)     = % whose too_cheap answer ≥ p   (descending)
 *   curve_bargain(p)       = % whose bargain answer ≥ p     (descending)
 *   curve_expensive(p)     = % whose expensive answer ≤ p   (ascending)
 *   curve_too_expensive(p) = % whose too_expensive answer ≤ p (ascending)
 * Intersections via shared curveIntersection:
 *   PMC = too_cheap × expensive, PME = bargain × too_expensive,
 *   OPP = too_cheap × too_expensive, IPP = bargain × expensive.
 */
function computeVanWestendorp(byQ, qs) {
  const qByBand = {};
  for (const q of qs) {
    if (q.methodology === 'van_westendorp' && VW_BANDS.includes(q.vw_band) && !qByBand[q.vw_band]) {
      qByBand[q.vw_band] = q; // first question per band wins (generator emits exactly one each)
    }
  }
  const missing = VW_BANDS.filter((b) => !qByBand[b]);
  if (missing.length > 0) {
    return { block: null, reason: `missing vw_band question(s): ${missing.join(', ')}` };
  }

  // persona → { too_cheap, bargain, expensive, too_expensive } (parsed).
  const perPersona = new Map();
  for (const band of VW_BANDS) {
    for (const r of byQ.get(qByBand[band].id) || []) {
      if (!r.persona_id) continue;
      const p = parsePrice(r.answer);
      if (p === null) continue;
      if (!perPersona.has(r.persona_id)) perPersona.set(r.persona_id, {});
      const rec = perPersona.get(r.persona_id);
      if (rec[band] === undefined) rec[band] = p; // first clean answer per persona wins
    }
  }
  const complete = [...perPersona.values()].filter((rec) => VW_BANDS.every((b) => rec[b] !== undefined));
  const n = complete.length;
  if (n < 2) {
    return { block: null, reason: `fewer than 2 respondents with all 4 VW answers (n=${n})` };
  }

  const grid = [...new Set(complete.flatMap((rec) => VW_BANDS.map((b) => rec[b])))].sort((a, b) => a - b);
  if (grid.length < 2) {
    return { block: null, reason: 'fewer than 2 distinct VW price points' };
  }

  const pct = (count) => round4((count / n) * 100);
  const curves = {
    too_cheap: grid.map((x) => ({ x, y: pct(complete.filter((r) => r.too_cheap >= x).length) })),
    bargain: grid.map((x) => ({ x, y: pct(complete.filter((r) => r.bargain >= x).length) })),
    expensive: grid.map((x) => ({ x, y: pct(complete.filter((r) => r.expensive <= x).length) })),
    too_expensive: grid.map((x) => ({ x, y: pct(complete.filter((r) => r.too_expensive <= x).length) })),
  };
  const points = {
    pmc: curveIntersection(curves.too_cheap, curves.expensive),
    pme: curveIntersection(curves.bargain, curves.too_expensive),
    opp: curveIntersection(curves.too_cheap, curves.too_expensive),
    ipp: curveIntersection(curves.bargain, curves.expensive),
  };
  return { block: { n, curves, points }, reason: null };
}

/**
 * Gabor-Granger block. Per anchor question: base n = answers matching
 * one of the 5 canonical options (claudeAI.js L615; case-insensitive),
 * demand = top-2-box share of that base, revenue_index = price ×
 * demand share (share as fraction, so revenue_index is in currency
 * units). optimal_price = anchor with max revenue_index; ties go to the
 * LOWER price (ascending scan with strict >).
 */
function computeGaborGranger(byQ, qs) {
  const ggQs = qs
    .filter((q) => q.methodology === 'gabor_granger')
    .sort((a, b) => ((num(a.gg_anchor_index) ?? 99) - (num(b.gg_anchor_index) ?? 99))
      || String(a.id).localeCompare(String(b.id)));
  if (ggQs.length === 0) return { block: null, reason: 'no gabor_granger questions' };

  const ladder = [];
  for (const q of ggQs) {
    const price = ggAnchorPrice(q);
    if (price === null) continue; // unparseable anchor → rung incomputable, skip
    let base = 0;
    let aff = 0;
    for (const r of byQ.get(q.id) || []) {
      const norm = typeof r.answer === 'string' ? r.answer.trim().toLowerCase() : null;
      if (!norm || !GG_OPTIONS.has(norm)) continue; // junk / off-scale answers drop from the base
      base += 1;
      if (GG_AFFIRMATIVE.has(norm)) aff += 1;
    }
    if (base === 0) continue; // no usable answers for this rung
    ladder.push({
      price,
      n: base,
      demand_pct: round4((aff / base) * 100),
      revenue_index: round4(price * (aff / base)),
    });
  }
  if (ladder.length === 0) {
    return { block: null, reason: 'no GG rung with a parseable anchor price and usable answers' };
  }
  ladder.sort((a, b) => a.price - b.price);
  let optimal = ladder[0];
  for (const rung of ladder) {
    if (rung.revenue_index > optimal.revenue_index) optimal = rung; // strict > keeps the lower price on ties
  }
  return { block: { ladder, optimal_price: optimal.price }, reason: null };
}

/**
 * Pricing analysis entry point.
 * @param {Array<{persona_id, question_id, answer}>} rows  clean mission_responses
 * @param {Array<object>} questions  generator question objects (see header)
 * @param {object} [mission]  used only for currency fallback
 * @returns plain JSON, top-level methodology:'pricing'; sections null when
 *          incomputable, with sibling *_degenerate_reason keys explaining why.
 */
function computePricing(rows, questions, mission) {
  const safeRows = Array.isArray(rows)
    ? rows.filter((r) => r && r.question_id)
    : [];
  const qs = Array.isArray(questions) ? questions.filter((q) => q && typeof q === 'object') : [];
  const byQ = byQuestion(safeRows);
  const n = personaCount(safeRows);

  // claudeAI.js L620: currency is set on every VW + GG + WTP question;
  // first question carrying one wins, then mission clarify, then USD.
  const currencyQ = qs.find((q) => typeof q.currency === 'string' && q.currency.length > 0);
  const currency = (currencyQ && currencyQ.currency)
    || (mission && mission.clarify_answers && mission.clarify_answers.pricing_currency)
    || 'USD';

  const vw = computeVanWestendorp(byQ, qs);
  const gg = computeGaborGranger(byQ, qs);

  // WTP ceiling (claudeAI.js L618): open-numeric text → parsePrice each
  // answer, then reuse the shared ratingStats math (mean/sd/95% CI).
  const wtpQ = qs.find((q) => q.methodology === 'wtp_ceiling');
  let wtp = null;
  if (wtpQ) {
    const parsed = (byQ.get(wtpQ.id) || [])
      .map((r) => parsePrice(r.answer))
      .filter((v) => v !== null);
    wtp = ratingStats(parsed.map((v, i) => ({ persona_id: `wtp_${i}`, answer: v })));
  }

  // Acceptable price range = [PMC, PME] when both intersections exist.
  const points = vw.block ? vw.block.points : null;
  const acceptable_range = points && points.pmc !== null && points.pme !== null
    ? { low: points.pmc, high: points.pme }
    : null;

  return {
    methodology: 'pricing',
    currency,
    n,
    van_westendorp: vw.block,
    van_westendorp_degenerate_reason: vw.reason,
    gabor_granger: gg.block,
    gabor_granger_degenerate_reason: gg.reason,
    wtp_ceiling: wtp,
    acceptable_range,
  };
}

module.exports = { computePricing, parsePrice };
