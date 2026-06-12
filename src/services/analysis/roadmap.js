/**
 * Pass 46 Phase 3 — deterministic feature-roadmap analysis:
 * MaxDiff (count-based best-worst scaling) + Kano classification.
 *
 * Doctrine: the LLM does NOT compute methodology math. Every number the
 * roadmap report shows is computed here, deterministically, from clean
 * mission_responses rows. Never throws; incomputable → null.
 *
 * Question metadata this module keys on — quoted from the generator
 * prompt ROADMAP_SURVEY_GEN_SYSTEM in src/services/claudeAI.js:
 *   L729  "type": "single|max_diff_set"
 *   L735  "methodology": "screener|max_diff|kano"
 *   L736  "feature_set": ["id1","id2","id3","id4"]
 *   L737  "feature_id": "f3"
 *   L738  "kano_type": "functional|dysfunctional"
 *   L755  "feature_set carries the 4 feature ids in display order"
 *   L757  "options should list the 4 feature names verbatim (the
 *          simulator interprets the answer as {best: id, worst: id})"
 *          → options[i] ↔ feature_set[i] positionally, which lets us
 *            resolve answers given as feature NAMES back to ids.
 *   L759  Kano functional: 'text="How would you feel if [feature name]
 *          WAS in the product?" type="single", options=["I like it",
 *          "I expect it","Neutral","I can live with it","I dislike it"]'
 *   L760  Kano dysfunctional: '"How would you feel if [feature name]
 *          WAS NOT in the product?" same 5 options.'
 *   L761  "feature_id carries the feature id on both pair members."
 *
 * MaxDiff answer shapes handled (L757 specifies the object form; the
 * simulator returns answers as JSON values — src/services/ai/simulate.js
 * L62-69 — so a stringified object or a labeled string can also occur):
 *   1. object  {best: 'f1', worst: 'f4'}            (canonical, L757)
 *   2. string  '{"best":"f1","worst":"f4"}'          (JSON-encoded object)
 *   3. string  'best: Speed boost, worst: CSV export' (labeled fallback)
 * Values may be feature ids OR option labels; labels resolve to ids via
 * the options↔feature_set positional mapping (L755+L757).
 */

const { byQuestion, round4, personaCount } = require('./shared');

// claudeAI.js L759-760 option strings, normalized (trim + lowercase).
const KANO_SCALE = {
  'i like it': 'like',
  'i expect it': 'expect',
  'neutral': 'neutral',
  'i can live with it': 'live_with',
  'i dislike it': 'dislike',
};

/**
 * Canonical 5×5 Kano evaluation table — rows = functional answer,
 * columns = dysfunctional answer, both in scale order
 * [like, expect(must-be), neutral, live_with, dislike].
 * Source: Sauerwein, Bailom, Hinterhuber & Matzler (1996), "The Kano
 * Model: How to delight your customers" — the standard table:
 *
 *            | like  expect neutral live_with dislike
 *   like     |  Q      A      A        A        O(P)
 *   expect   |  R      I      I        I        M
 *   neutral  |  R      I      I        I        M
 *   live_with|  R      I      I        I        M
 *   dislike  |  R      R      R        R        Q
 *
 * A=attractive, O/P=performance (one-dimensional), M=must_be,
 * I=indifferent, R=reverse, Q=questionable.
 */
const KANO_TABLE = {
  like: { like: 'questionable', expect: 'attractive', neutral: 'attractive', live_with: 'attractive', dislike: 'performance' },
  expect: { like: 'reverse', expect: 'indifferent', neutral: 'indifferent', live_with: 'indifferent', dislike: 'must_be' },
  neutral: { like: 'reverse', expect: 'indifferent', neutral: 'indifferent', live_with: 'indifferent', dislike: 'must_be' },
  live_with: { like: 'reverse', expect: 'indifferent', neutral: 'indifferent', live_with: 'indifferent', dislike: 'must_be' },
  dislike: { like: 'reverse', expect: 'reverse', neutral: 'reverse', live_with: 'reverse', dislike: 'questionable' },
};

// Modal-classification tie-break, per the Kano evaluation rule
// M > O > A > I (must-be beats performance beats attractive beats
// indifferent), with the pathological categories last.
const KANO_TIEBREAK = ['must_be', 'performance', 'attractive', 'indifferent', 'reverse', 'questionable'];

/**
 * Resolve one best/worst value to a feature id for question q:
 * exact id in feature_set → itself; case-insensitive id match; else
 * case-insensitive option-label match → feature_set[same index]
 * (display-order correspondence, claudeAI.js L755 + L757).
 */
function resolveFeature(value, q) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw.length === 0) return null;
  const set = q.feature_set;
  if (set.includes(raw)) return raw;
  const lower = raw.toLowerCase();
  const idHit = set.find((fid) => String(fid).toLowerCase() === lower);
  if (idHit !== undefined) return idHit;
  if (Array.isArray(q.options)) {
    const idx = q.options.findIndex((o) => String(o).trim().toLowerCase() === lower);
    if (idx >= 0 && set[idx] !== undefined) return set[idx];
  }
  return null;
}

/**
 * Parse one MaxDiff answer (shapes 1-3 in the header) → {best, worst}
 * feature ids, or null when the row carries no valid best+worst signal
 * (unresolvable values, best === worst, or ids outside feature_set).
 */
function parseMaxDiffAnswer(answer, q) {
  let a = answer;
  if (typeof a === 'string') {
    const s = a.trim();
    if (s.startsWith('{')) {
      try { a = JSON.parse(s); } catch { a = s; }
    }
  }
  let best = null;
  let worst = null;
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    best = resolveFeature(a.best, q);
    worst = resolveFeature(a.worst, q);
  } else if (typeof a === 'string') {
    const bm = a.match(/best\s*[:=\-]\s*"?([^",;\n]+)/i);
    const wm = a.match(/worst\s*[:=\-]\s*"?([^",;\n]+)/i);
    if (bm) best = resolveFeature(bm[1], q);
    if (wm) worst = resolveFeature(wm[1], q);
  }
  if (best === null || worst === null || best === worst) return null;
  return { best, worst };
}

/**
 * Feature id → display label. Sources, in priority order:
 *   1. mission.clarify_answers.roadmap_features — JSON string (or array)
 *      of {id, name}; this is what buildRoadmapUserPrompt feeds the
 *      generator (claudeAI.js L799 reads clarify.roadmap_features).
 *   2. MaxDiff options↔feature_set positional names (L755 + L757).
 * Kano question text is NOT parsed for names (fragile); unlabeled → null.
 */
function featureLabels(qs, mission) {
  const labels = new Map();
  let raw = mission && mission.clarify_answers ? mission.clarify_answers.roadmap_features : undefined;
  if (raw === undefined && mission && mission.clarify) raw = mission.clarify.roadmap_features;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  if (Array.isArray(raw)) {
    for (const f of raw) {
      if (f && f.id !== undefined && f.name && !labels.has(String(f.id))) labels.set(String(f.id), String(f.name));
    }
  }
  for (const q of qs) {
    if (q.methodology !== 'max_diff' || !Array.isArray(q.feature_set) || !Array.isArray(q.options)) continue;
    q.feature_set.forEach((fid, i) => {
      if (fid !== undefined && fid !== null && q.options[i] !== undefined && !labels.has(String(fid))) {
        labels.set(String(fid), String(q.options[i]));
      }
    });
  }
  return labels;
}

/**
 * MaxDiff block (count-based scoring). Per feature:
 *   utility = (bestCount − worstCount) / appearances
 * where appearances counts every VALID answered row whose feature_set
 * contains the feature (rows with unparseable answers contribute no
 * appearances — they carry no best/worst signal). Ranking: utility desc,
 * ties → best desc, then feature_id asc (deterministic).
 */
function computeMaxDiff(byQ, qs, labels) {
  const mdQs = qs.filter((q) => q.methodology === 'max_diff'
    && Array.isArray(q.feature_set) && q.feature_set.length >= 2);
  if (mdQs.length === 0) return { block: null, reason: 'no max_diff questions with a valid feature_set' };

  const stats = new Map(); // feature_id → {best, worst, appearances}
  const ensure = (fid) => {
    if (!stats.has(fid)) stats.set(fid, { best: 0, worst: 0, appearances: 0 });
    return stats.get(fid);
  };
  for (const q of mdQs) for (const fid of q.feature_set) ensure(fid);

  let validRows = 0;
  const answeringPersonas = new Set();
  for (const q of mdQs) {
    for (const r of byQ.get(q.id) || []) {
      const parsed = parseMaxDiffAnswer(r.answer, q);
      if (!parsed) continue;
      validRows += 1;
      if (r.persona_id) answeringPersonas.add(r.persona_id);
      for (const fid of q.feature_set) ensure(fid).appearances += 1;
      ensure(parsed.best).best += 1;
      ensure(parsed.worst).worst += 1;
    }
  }
  if (validRows === 0) return { block: null, reason: 'no parseable MaxDiff best/worst answers' };

  const features = [...stats.entries()].map(([feature_id, s]) => ({
    feature_id,
    label: labels.get(String(feature_id)) ?? null,
    utility: s.appearances > 0 ? round4((s.best - s.worst) / s.appearances) : null,
    best: s.best,
    worst: s.worst,
    appearances: s.appearances,
  }));
  features.sort((a, b) => {
    if (a.utility === null && b.utility === null) return String(a.feature_id).localeCompare(String(b.feature_id));
    if (a.utility === null) return 1; // never-shown features sink to the bottom
    if (b.utility === null) return -1;
    return (b.utility - a.utility) || (b.best - a.best)
      || String(a.feature_id).localeCompare(String(b.feature_id));
  });
  return {
    block: {
      n: answeringPersonas.size, // distinct personas with ≥1 valid MaxDiff answer
      features,
      ranking: features.map((f) => f.feature_id),
    },
    reason: null,
  };
}

/**
 * Kano block. Pairs each persona's functional + dysfunctional answer per
 * feature_id (claudeAI.js L761: both pair members carry feature_id),
 * maps the pair through KANO_TABLE, and reports per feature the modal
 * classification + full category counts + paired base n. Personas
 * missing either half of the pair (or answering off-scale) are excluded.
 */
function computeKano(byQ, qs, labels) {
  const kanoQs = qs.filter((q) => q.methodology === 'kano'
    && q.feature_id !== undefined && q.feature_id !== null
    && (q.kano_type === 'functional' || q.kano_type === 'dysfunctional'));
  if (kanoQs.length === 0) return { block: null, reason: 'no kano questions' };

  // feature_id → persona_id → {functional, dysfunctional} scale points.
  const byFeature = new Map();
  for (const q of kanoQs) {
    for (const r of byQ.get(q.id) || []) {
      if (!r.persona_id) continue;
      const scale = typeof r.answer === 'string' ? KANO_SCALE[r.answer.trim().toLowerCase()] : undefined;
      if (!scale) continue;
      if (!byFeature.has(q.feature_id)) byFeature.set(q.feature_id, new Map());
      const personas = byFeature.get(q.feature_id);
      if (!personas.has(r.persona_id)) personas.set(r.persona_id, {});
      const rec = personas.get(r.persona_id);
      if (rec[q.kano_type] === undefined) rec[q.kano_type] = scale; // first clean answer wins
    }
  }

  const features = [];
  for (const [feature_id, personas] of byFeature) {
    const counts = { attractive: 0, must_be: 0, performance: 0, indifferent: 0, reverse: 0, questionable: 0 };
    let paired = 0;
    for (const rec of personas.values()) {
      if (!rec.functional || !rec.dysfunctional) continue;
      paired += 1;
      counts[KANO_TABLE[rec.functional][rec.dysfunctional]] += 1;
    }
    if (paired === 0) continue; // no complete pairs → feature incomputable, omit
    let classification = null;
    for (const cat of KANO_TIEBREAK) {
      if (classification === null || counts[cat] > counts[classification]) classification = cat;
    }
    features.push({
      feature_id,
      label: labels.get(String(feature_id)) ?? null,
      classification,
      n: paired,
      counts,
    });
  }
  if (features.length === 0) {
    return { block: null, reason: 'no personas with paired functional+dysfunctional answers' };
  }
  features.sort((a, b) => String(a.feature_id).localeCompare(String(b.feature_id)));
  return { block: { features }, reason: null };
}

/**
 * Roadmap analysis entry point.
 * @param {Array<{persona_id, question_id, answer}>} rows  clean mission_responses
 * @param {Array<object>} questions  generator question objects (see header)
 * @param {object} [mission]  used only for feature labels (clarify roadmap_features)
 * @returns plain JSON, top-level methodology:'roadmap'; sections null when
 *          incomputable, with sibling *_degenerate_reason keys explaining why.
 */
function computeRoadmap(rows, questions, mission) {
  const safeRows = Array.isArray(rows)
    ? rows.filter((r) => r && r.question_id)
    : [];
  const qs = Array.isArray(questions) ? questions.filter((q) => q && typeof q === 'object') : [];
  const byQ = byQuestion(safeRows);
  const labels = featureLabels(qs, mission);

  const maxdiff = computeMaxDiff(byQ, qs, labels);
  const kano = computeKano(byQ, qs, labels);

  return {
    methodology: 'roadmap',
    n: personaCount(safeRows),
    maxdiff: maxdiff.block,
    maxdiff_degenerate_reason: maxdiff.reason,
    kano: kano.block,
    kano_degenerate_reason: kano.reason,
  };
}

module.exports = { computeRoadmap, parseMaxDiffAnswer, KANO_TABLE };
