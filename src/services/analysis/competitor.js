/**
 * Pass 46 Phase 3 / Pass 47 — deterministic COMPETITOR ANALYSIS
 * (Brand Health Tracker: 5-stage funnel + NPS + attributes + switching + WoM).
 *
 * Doctrine (Pass 46): the LLM does NOT compute methodology math. This
 * module turns clean mission_responses rows ({persona_id, question_id,
 * answer}) into every number the competitor report shows.
 * Deterministic, never throws, incomputable → null.
 *
 * PASS 47 — the perceptual-map radar needs EVERY brand scored on the same
 * attribute axes. The fixed generator now emits ONE attribute battery per
 * brand (focal + each competitor), all funnel_stage="attributes", identical
 * options, brand_id set per brand (focal = "our_brand"). This module:
 *   • anchors the focal brand from mission.brand_name OR the "our_brand"
 *     brand_id convention OR the first aided-awareness option — robust to a
 *     null/generic focal (real mission 4515fed5 has brand_name=null and the
 *     focal label is literally "Our Brand"/brand_id "our_brand");
 *   • reads funnel_stage="attributes" batteries (and still tolerates the
 *     LEGACY shape where the focal battery rode funnel_stage="awareness");
 *   • produces per-brand attribute endorsement % on the shared battery, so
 *     the radar has ≥2 brands on shared axes when the survey carries
 *     per-brand batteries.
 *
 * Question metadata contract — quoted from the generator prompt
 * COMPETITOR_SURVEY_GEN_SYSTEM (src/services/claudeAI.js). Every question
 * carries methodology="brand_health_tracker" and a funnel_stage ∈
 * "screener|awareness|consideration|preference|use|recommendation|
 * attributes|switching|wom". The fixed funnel questions:
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
 *  ATTRIBUTE BATTERIES — funnel_stage="attributes" (PASS 47), type="multi",
 *      ONE question per brand, text 'Which of these attributes apply to
 *      <brand>? …', IDENTICAL options = the attribute battery (NOT brands),
 *      brand_id = that brand's id (focal = "our_brand"). ANSWER: array of
 *      selected attribute strings; endorsement is binary, so the
 *      brand×attribute "mean" is the endorsement % (0-100) of the
 *      question's answer base. LEGACY tolerance: an old focal-only battery
 *      rode funnel_stage="awareness" with attribute (non-brand) options;
 *      such questions are still detected and attributed to the focal brand.
 *  SWITCHING INTENT  — funnel_stage="switching", type="rating" 1-5.
 *  SWITCHING TARGET  — funnel_stage="switching", type="single",
 *      options = competitor list.
 *  WORD-OF-MOUTH     — funnel_stage="wom", type="single", options=
 *      ["Yes - positively","Yes - negatively",
 *       "No, but I've thought about them","No, not at all"].
 *
 * Focal anchoring (PASS 47, robust to a null/generic focal): in priority
 * order — (1) mission.brand_name; (2) the brand whose battery/NPS/wom
 * question carries brand_id matching the focal convention ("our_brand", or
 * "focal"/"focal_brand"/"us"); (3) the label "Our Brand" if present among
 * brands; (4) the first aided-awareness option. competitors = mission.
 * competitor_brands — a JSONB array of brand-name strings. All brand
 * matching is case-insensitive on trimmed labels; non-convention brands
 * have no other stable id, so the label IS the brand_id in this module's
 * output (the focal brand_id stays its label too, for output stability).
 */

const {
  ratingStats, round4, personaCount, shares, distribution, num,
} = require('./shared');

const norm = (v) => String(v ?? '').trim().toLowerCase();
const NONE_OF_THESE = 'none of these';
const toArray = (a) => (Array.isArray(a) ? a : [a]);
// PASS 47: brand_id values the generator uses for the focal brand. The fixed
// prompt emits "our_brand"; the others are tolerated so a focal-id rename
// upstream still anchors here.
const FOCAL_BRAND_IDS = new Set(['our_brand', 'focal', 'focal_brand', 'us']);
const isFocalBrandId = (v) => FOCAL_BRAND_IDS.has(norm(v));

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

  // ── Brand registry (insertion order = report order): mission focal +
  // competitors, then brands discovered in question options. ──
  const missionFocal = mission.brand_name ? String(mission.brand_name).trim() || null : null;
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
  if (missionFocal) addBrand(missionFocal);
  for (const c of parseBrandList(mission.competitor_brands)) addBrand(c);

  // ── Identify aided-awareness vs attribute batteries. ──
  // PASS 47: attribute batteries carry funnel_stage="attributes". For
  // BACKWARD COMPAT, the legacy focal battery rode funnel_stage="awareness"
  // alongside aided awareness (q3). Both are type!="text" with options; q3's
  // options are brand labels, a battery's are attributes. Disambiguate by
  // option content: ≥50% of options matching known brands (or "None of
  // these") → the brand (aided) question; otherwise an attribute battery.
  // With no known brands yet, fall back to prompt order (first = aided).
  const brandRatio = (q) => {
    if (!Array.isArray(q.options) || q.options.length === 0) return 0;
    const matches = q.options
      .filter((o) => brandByNorm.has(norm(o)) || norm(o) === NONE_OF_THESE).length;
    return matches / q.options.length;
  };
  const awarenessOptionQs = questions.filter((q) => q
    && q.funnel_stage === 'awareness'
    && q.type !== 'text'
    && Array.isArray(q.options) && q.options.length > 0);
  let aidedQ = null;
  if (brandByNorm.size > 0) {
    aidedQ = awarenessOptionQs.find((q) => brandRatio(q) >= 0.5) || null;
  } else {
    aidedQ = awarenessOptionQs[0] || null;
  }
  if (aidedQ) for (const o of aidedQ.options) addBrand(o);

  // Funnel questions are unambiguous by funnel_stage; their options are
  // brand labels too — register them so the resolver and brand list stay
  // complete even without mission context.
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

  // Attribute batteries: every funnel_stage="attributes" question (PASS 47),
  // plus legacy awareness option-questions that are not the aided question
  // and whose options do NOT look like brands.
  const attributeQs = [
    ...questions.filter((q) => q && q.funnel_stage === 'attributes'
      && q.type !== 'text' && Array.isArray(q.options) && q.options.length > 0),
    ...awarenessOptionQs.filter((q) => q !== aidedQ && brandRatio(q) < 0.5),
  ];

  // ── Focal anchoring (PASS 47, robust to a null/generic focal). Priority:
  //  1) mission.brand_name;
  //  2) a brand named by a question carrying a focal-convention brand_id
  //     ("our_brand", …) — resolved to a brand label found in its text;
  //  3) the literal "Our Brand" if present among brands;
  //  4) the first aided-awareness option. ──
  const labelsByLength = () => [...brandLabels]
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  const labelInText = (text) => {
    const t = norm(text);
    for (const label of labelsByLength()) if (t.includes(norm(label))) return label;
    return null;
  };
  let focalLabel = missionFocal;
  if (!focalLabel) {
    // brand_id="our_brand" appears on the focal NPS / wom / attribute
    // questions; pull the focal LABEL from any such question's text.
    const focalIdQ = questions.find((q) => q && isFocalBrandId(q.brand_id));
    if (focalIdQ) {
      focalLabel = labelInText(focalIdQ.text)
        // attribute batteries name the focal in text too; otherwise look
        // across all focal-id questions for a recognizable brand label.
        || (() => {
          for (const q of questions) {
            if (!q || !isFocalBrandId(q.brand_id)) continue;
            const l = labelInText(q.text);
            if (l) return l;
          }
          return null;
        })();
    }
  }
  if (!focalLabel) {
    const ourBrand = brandLabels.find((l) => norm(l) === 'our brand');
    if (ourBrand) focalLabel = ourBrand;
  }
  if (!focalLabel && aidedQ && Array.isArray(aidedQ.options) && aidedQ.options.length) {
    focalLabel = String(aidedQ.options[0]).trim() || null;
  }
  // Make sure the focal label is in the registry (and stays first in order
  // when mission context was empty — its battery still resolves to it).
  if (focalLabel) addBrand(focalLabel);

  // ── Per-brand question resolver: focal-convention brand_id → focal label;
  // else brand_id matching a known label; else longest brand label found in
  // the question text; else focal fallback. ──
  const resolveBrand = (q) => {
    if (isFocalBrandId(q.brand_id)) return focalLabel;
    if (q.brand_id !== null && q.brand_id !== undefined && brandByNorm.has(norm(q.brand_id))) {
      return brandByNorm.get(norm(q.brand_id));
    }
    const fromText = labelInText(q.text);
    if (fromText) return fromText;
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
