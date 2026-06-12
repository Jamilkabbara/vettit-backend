/**
 * Pass 46 Phase 3 — deterministic COMPETITOR ANALYSIS
 * (Brand Health Tracker: 5-stage funnel + NPS + attributes + switching + WoM).
 *
 * Doctrine (Pass 46): the LLM does NOT compute methodology math. This
 * module turns clean mission_responses rows ({persona_id, question_id,
 * answer}) into every number the competitor report shows.
 * Deterministic, never throws, incomputable → null.
 *
 * Question metadata contract — quoted from the generator prompt
 * COMPETITOR_SURVEY_GEN_SYSTEM (src/services/claudeAI.js:1416-1457).
 * Every question carries methodology="brand_health_tracker" and a
 * funnel_stage ∈ "screener|awareness|consideration|preference|use|
 * recommendation|switching|wom" (claudeAI.js:1433). The 11 fixed
 * questions (claudeAI.js:1441-1452):
 *
 *  q2  UNAIDED AWARENESS — funnel_stage="awareness", type="text".
 *      Free text → narrative layer; no math here.
 *  q3  AIDED AWARENESS   — funnel_stage="awareness", type="multi",
 *      'options = [<focal_brand>, ...<competitors>] in supplied order'
 *      (claudeAI.js:1444). ANSWER SHAPE: array of brand-label option
 *      strings (simulate.js:48,66).
 *  q4  CONSIDERATION     — funnel_stage="consideration", type="multi",
 *      options same as q3. ANSWER: array of brand labels.
 *  q5  PREFERENCE        — funnel_stage="preference", type="single",
 *      options same as q3. ANSWER: one brand label string.
 *  q6  CURRENT USE       — funnel_stage="use", type="single",
 *      options = q3 + "None of these". ANSWER: one option string.
 *  q7  NPS               — funnel_stage="recommendation", type="rating"
 *      0-10, text 'How likely are you to recommend [<focal_brand>] …',
 *      brand_id=<focal_brand_id>. claudeAI.js:1453: "emit q7 once with
 *      brand_id set to the focal brand id; downstream aggregator
 *      extends to competitors" → this module accepts ANY number of
 *      recommendation questions and resolves each to a brand via
 *      brand_id (case-insensitive) → question-text label scan → focal
 *      fallback. ANSWER: a number 0-10 (simulate.js:67).
 *  q8  ATTRIBUTE MATRIX  — funnel_stage="awareness" (!), type="multi",
 *      text 'Which of these attributes apply to <focal_brand>? …',
 *      options = the attribute battery, NOT brands (claudeAI.js:1449).
 *      Disambiguated from q3 by checking whether the options match
 *      known brand labels. ANSWER: array of selected attribute strings;
 *      endorsement is binary, so the brand×attribute "mean" is the
 *      endorsement percentage (0-100) of the question's answer base.
 *  q9  SWITCHING INTENT  — funnel_stage="switching", type="rating" 1-5.
 *  q10 SWITCHING TARGET  — funnel_stage="switching", type="single",
 *      options = competitor list (claudeAI.js:1451).
 *  q11 WORD-OF-MOUTH     — funnel_stage="wom", type="single", options=
 *      ["Yes - positively","Yes - negatively",
 *       "No, but I've thought about them","No, not at all"]
 *      (claudeAI.js:1452).
 *
 * Focal brand = mission.brand_name; competitors = mission.
 * competitor_brands — a JSONB array of brand-name strings
 * (buildCompetitorUserPrompt JSON.parses it and joins with ', ',
 * claudeAI.js:1480-1484). All brand matching is case-insensitive on
 * trimmed labels; brands have no other stable id, so the label IS the
 * brand_id in this module's output.
 */

const {
  ratingStats, round4, personaCount, shares, distribution, num,
} = require('./shared');

const norm = (v) => String(v ?? '').trim().toLowerCase();
const NONE_OF_THESE = 'none of these';
const toArray = (a) => (Array.isArray(a) ? a : [a]);

/** competitor_brands: array (JSONB) | JSON string | legacy 'A|B' / 'A,B' string. */
function parseBrandList(v) {
  let arr = [];
  if (Array.isArray(v)) {
    arr = v;
  } else if (typeof v === 'string' && v.trim()) {
    try {
      const p = JSON.parse(v);
      arr = Array.isArray(p) ? p : [];
    } catch {
      // cf. the pipe-separated c.competitors fallback in
      // buildCompetitorUserPrompt (claudeAI.js:1482-1484).
      arr = v.split(/[|,]/);
    }
  }
  return arr
    .map((c) => (typeof c === 'string' ? c : String((c && (c.name || c.label || c.brand)) || '')))
    .map((s) => s.trim())
    .filter(Boolean);
}

function safePersonaCount(rows) {
  try { return personaCount(Array.isArray(rows) ? rows : []); } catch { return 0; }
}

/**
 * Pass 46 Phase 3 — competitor / brand-health analysis.
 * @param {Array<{persona_id, question_id, answer}>} rows clean mission_responses
 * @param {Array<object>} questions mission questions (carry the metadata above)
 * @param {object} mission mission row — brand_name + competitor_brands
 */
function computeCompetitor(rows, questions, mission) {
  try {
    return computeCompetitorInner(
      Array.isArray(rows) ? rows : [],
      Array.isArray(questions) ? questions : [],
      mission && typeof mission === 'object' ? mission : {},
    );
  } catch (err) {
    // Contract: never throw.
    return {
      methodology: 'competitor',
      n: safePersonaCount(rows),
      focal_brand: null,
      brands: [],
      share_of_preference: null,
      switching: null,
      wom: null,
      gaps: null,
      error: `competitor_analysis_failed: ${err.message}`,
    };
  }
}

function computeCompetitorInner(rows, questions, mission) {
  const rowsByQ = new Map();
  for (const r of rows) {
    if (!r || !r.question_id) continue;
    if (!rowsByQ.has(r.question_id)) rowsByQ.set(r.question_id, []);
    rowsByQ.get(r.question_id).push(r);
  }
  const answered = (qid) => (rowsByQ.get(qid) || [])
    .filter((r) => r.answer !== null && r.answer !== undefined);

  // ── Brand registry (insertion order = report order): focal, mission
  // competitors, then brands discovered in question options. ──
  const focalLabel = mission.brand_name ? String(mission.brand_name).trim() || null : null;
  const brandLabels = [];
  const brandByNorm = new Map(); // norm(label) → canonical label
  const addBrand = (label) => {
    const trimmed = String(label ?? '').trim();
    const k = norm(trimmed);
    if (!k || k === NONE_OF_THESE) return;
    if (!brandByNorm.has(k)) {
      brandByNorm.set(k, trimmed);
      brandLabels.push(trimmed);
    }
  };
  if (focalLabel) addBrand(focalLabel);
  for (const c of parseBrandList(mission.competitor_brands)) addBrand(c);

  // ── Identify the aided-awareness question vs the attribute matrix.
  // Both are funnel_stage="awareness" + type="multi" (q3 claudeAI.js:1444,
  // q8 claudeAI.js:1449); q3's options are brand labels, q8's are
  // attributes. Test: ≥50% of options matching known brands (or "None
  // of these") → brand-option question. With no known brands at all,
  // fall back to prompt order: the FIRST awareness option-question is
  // q3 (aided), the rest are attribute batteries. ──
  const awarenessOptionQs = questions.filter((q) => q
    && q.funnel_stage === 'awareness'
    && q.type !== 'text'
    && Array.isArray(q.options) && q.options.length > 0);
  const brandRatio = (q) => {
    const matches = q.options
      .filter((o) => brandByNorm.has(norm(o)) || norm(o) === NONE_OF_THESE).length;
    return matches / q.options.length;
  };
  let aidedQ = null;
  if (brandByNorm.size > 0) {
    aidedQ = awarenessOptionQs.find((q) => brandRatio(q) >= 0.5) || null;
  } else {
    aidedQ = awarenessOptionQs[0] || null;
  }
  if (aidedQ) for (const o of aidedQ.options) addBrand(o);

  // Funnel questions are unambiguous by funnel_stage; their options are
  // brand labels too (claudeAI.js:1445-1447,1451) — register them so the
  // resolver and brand list stay complete even without mission context.
  const firstStage = (stage, pred) => questions
    .find((q) => q && q.funnel_stage === stage && (!pred || pred(q))) || null;
  const considerationQ = firstStage('consideration');
  const preferenceQ = firstStage('preference');
  const useQ = firstStage('use');
  for (const q of [considerationQ, preferenceQ, useQ]) {
    if (q && Array.isArray(q.options)) for (const o of q.options) addBrand(o);
  }
  const switchingQs = questions.filter((q) => q && q.funnel_stage === 'switching');
  const switchIntentQ = switchingQs
    .find((q) => q.type === 'rating' || !(Array.isArray(q.options) && q.options.length > 0)) || null;
  const switchTargetQ = switchingQs
    .find((q) => q !== switchIntentQ && Array.isArray(q.options) && q.options.length > 0) || null;
  if (switchTargetQ) for (const o of switchTargetQ.options) addBrand(o);
  const womQ = firstStage('wom');

  // Attribute batteries: awareness option-questions that are not the
  // aided question and whose options do NOT look like brands.
  const attributeQs = awarenessOptionQs.filter((q) => q !== aidedQ && brandRatio(q) < 0.5);

  // ── Per-brand question resolver: brand_id (case-insensitive) →
  // longest brand label found in the question text → focal fallback
  // (claudeAI.js:1453 — q7 is emitted once for the focal brand). ──
  const labelsByLength = [...brandLabels].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const resolveBrand = (q) => {
    if (q.brand_id !== null && q.brand_id !== undefined && brandByNorm.has(norm(q.brand_id))) {
      return brandByNorm.get(norm(q.brand_id));
    }
    const text = norm(q.text);
    for (const label of labelsByLength) {
      if (text.includes(norm(label))) return label;
    }
    return focalLabel;
  };

  // ── Funnel shares: % of the question's answer base selecting/naming
  // the brand. Works for multi (array answer) and single (string). ──
  const selectionPct = (qRows, base, label) => {
    if (!qRows || base <= 0) return null;
    const count = qRows
      .filter((r) => toArray(r.answer).some((v) => norm(v) === norm(label))).length;
    return { pct: round4((count / base) * 100), count, base };
  };
  const stageRows = (q) => (q ? answered(q.id) : null);
  const aidedRows = stageRows(aidedQ);
  const considerationRows = stageRows(considerationQ);
  const preferenceRows = stageRows(preferenceQ);
  const useRows = stageRows(useQ);
  const aidedBase = aidedRows ? personaCount(aidedRows) : 0;
  const considerationBase = considerationRows ? personaCount(considerationRows) : 0;
  const preferenceBase = preferenceRows ? personaCount(preferenceRows) : 0;
  const useBase = useRows ? personaCount(useRows) : 0;

  // ── NPS per brand (claudeAI.js:1448: q7 type="rating" 0-10). A value
  // outside 0..10 means the question is not on the NPS scale → null,
  // never a wrong number. Promoters 9-10, passives 7-8, detractors 0-6;
  // score = promoters% − detractors%. ──
  const npsFromRows = (qRows) => {
    const nums = qRows.map((r) => num(r.answer)).filter((v) => v !== null);
    if (nums.length === 0) return null;
    if (nums.some((v) => v < 0 || v > 10)) return null;
    const base = nums.length;
    const promoters = nums.filter((v) => v >= 9).length;
    const detractors = nums.filter((v) => v <= 6).length;
    const promotersPct = round4((promoters / base) * 100);
    const detractorsPct = round4((detractors / base) * 100);
    return {
      score: round4(promotersPct - detractorsPct),
      promoters_pct: promotersPct,
      passives_pct: round4(((base - promoters - detractors) / base) * 100),
      detractors_pct: detractorsPct,
      base,
    };
  };
  const npsByBrand = new Map(); // norm(label) → nps object
  for (const q of questions) {
    if (!q || q.funnel_stage !== 'recommendation') continue;
    const label = resolveBrand(q);
    if (!label) continue;
    const k = norm(label);
    if (npsByBrand.has(k)) continue; // first computable question per brand wins
    const nps = npsFromRows(answered(q.id));
    if (nps) npsByBrand.set(k, nps);
  }

  // ── Attribute battery: brand × attribute endorsement % (radar source). ──
  const attrsByBrand = new Map(); // norm(label) → { attrs: {attr: pct}, base }
  for (const q of attributeQs) {
    const label = resolveBrand(q);
    if (!label) continue;
    const k = norm(label);
    const qRows = answered(q.id);
    const base = personaCount(qRows);
    if (base <= 0) continue;
    if (!attrsByBrand.has(k)) attrsByBrand.set(k, { attrs: {}, base });
    const slot = attrsByBrand.get(k);
    for (const attr of q.options) {
      if (slot.attrs[attr] !== undefined) continue; // first question wins per attr key
      const count = qRows
        .filter((r) => toArray(r.answer).some((v) => norm(v) === norm(attr))).length;
      slot.attrs[attr] = round4((count / base) * 100);
    }
  }

  // ── Brand roll-up ────────────────────────────────────────────────────
  const brands = brandLabels.map((label) => {
    const k = norm(label);
    const attrSlot = attrsByBrand.get(k) || null;
    return {
      brand_id: label, // labels are the only stable key — see header comment
      label,
      is_focal: focalLabel ? k === norm(focalLabel) : false,
      awareness_pct: aidedQ ? selectionPct(aidedRows, aidedBase, label) : null,
      consideration_pct: considerationQ ? selectionPct(considerationRows, considerationBase, label) : null,
      preference_pct: preferenceQ ? selectionPct(preferenceRows, preferenceBase, label) : null,
      use_pct: useQ ? selectionPct(useRows, useBase, label) : null,
      nps: npsByBrand.get(k) || null,
      attributes: attrSlot ? attrSlot.attrs : null,
      attributes_base: attrSlot ? attrSlot.base : null,
    };
  });

  // ── Share of preference (q5): full share table incl. any non-brand
  // answers, base = answered personas. ──
  let shareOfPreference = null;
  if (preferenceQ && preferenceBase > 0) {
    shareOfPreference = {
      question_id: preferenceQ.id,
      base: preferenceBase,
      shares: shares(distribution(preferenceRows), preferenceBase).shares,
    };
  }

  // ── Switching: intent distribution (q9, rating 1-5) + destination
  // shares (q10). ──
  let switching = null;
  if (switchIntentQ || switchTargetQ) {
    let intentBlock = null;
    if (switchIntentQ) {
      const iRows = answered(switchIntentQ.id);
      const base = personaCount(iRows);
      if (base > 0) {
        intentBlock = { base, distribution: distribution(iRows), stats: ratingStats(iRows) };
      }
    }
    let destBlock = null;
    if (switchTargetQ) {
      const tRows = answered(switchTargetQ.id);
      const base = personaCount(tRows);
      if (base > 0) {
        destBlock = { base, shares: shares(distribution(tRows), base).shares };
      }
    }
    if (intentBlock || destBlock) {
      switching = { intent_distribution: intentBlock, destinations: destBlock };
    }
  }

  // ── Word of mouth (q11): share table over the 4 fixed options. ──
  let wom = null;
  if (womQ) {
    const wRows = answered(womQ.id);
    const base = personaCount(wRows);
    if (base > 0) {
      wom = { question_id: womQ.id, base, shares: shares(distribution(wRows), base).shares };
    }
  }

  // ── Attribute gaps: focal vs best competitor per attribute.
  // gap = focal − best competitor → NEGATIVE gap = focal trails (spec).
  // Sorted ascending so the focal brand's worst deficits come first;
  // ties break on attribute name. null when the focal brand has no
  // attribute data; [] when it does but no competitor overlaps. ──
  let gaps = null;
  const focalSlot = focalLabel ? attrsByBrand.get(norm(focalLabel)) : null;
  if (focalSlot) {
    gaps = [];
    for (const [attr, focalMean] of Object.entries(focalSlot.attrs)) {
      let best = null;
      for (const label of brandLabels) {
        if (norm(label) === norm(focalLabel)) continue;
        const slot = attrsByBrand.get(norm(label));
        if (slot && slot.attrs[attr] !== undefined
          && (!best || slot.attrs[attr] > best.mean)) {
          best = { label, mean: slot.attrs[attr] };
        }
      }
      if (!best) continue;
      gaps.push({
        attribute: attr,
        focal_mean: focalMean,
        best_competitor: best.label,
        best_competitor_mean: best.mean,
        gap: round4(focalMean - best.mean),
      });
    }
    gaps.sort((a, b) => a.gap - b.gap || String(a.attribute).localeCompare(String(b.attribute)));
  }

  return {
    methodology: 'competitor',
    n: personaCount(rows),
    focal_brand: focalLabel,
    brands,
    share_of_preference: shareOfPreference,
    switching,
    wom,
    gaps,
  };
}

module.exports = { computeCompetitor };
