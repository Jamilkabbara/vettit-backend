/**
 * Pass 46 Phase 3 — competitor / brand-health analysis, hand-computed fixtures.
 *
 * Question metadata mirrors COMPETITOR_SURVEY_GEN_SYSTEM
 * (src/services/claudeAI.js:1416-1457): 11 questions keyed by
 * funnel_stage (screener/awareness/consideration/preference/use/
 * recommendation/switching/wom). Aided awareness (q3) and the attribute
 * matrix (q8) BOTH carry funnel_stage="awareness" + type="multi" — q3's
 * options are brand labels, q8's are attributes. NPS (q7) is
 * type="rating" 0-10 with brand_id; claudeAI.js:1453 says the
 * downstream aggregator extends it per brand, so the fixture carries
 * one NPS question per brand (focal via lowercase brand_id to prove
 * case-insensitive matching, competitor via question-text fallback).
 * Answers: multi → array of option strings, single → option string,
 * rating → number (simulate.js:47-50,65-67).
 */

const { computeCompetitor } = require('../src/services/analysis/competitor');

const row = (persona_id, question_id, answer) => ({ persona_id, question_id, answer });

const BRAND_OPTS = ['Vett', 'Acme', 'Zen'];

const QUESTIONS = [
  { id: 'q1', text: 'Have you bought project-management software in the past year?', type: 'single', isScreening: true, methodology: 'brand_health_tracker', funnel_stage: 'screener', options: ['Yes', 'No'] },
  { id: 'q2', text: 'What software brands come to mind? List up to 5.', type: 'text', methodology: 'brand_health_tracker', funnel_stage: 'awareness' },
  { id: 'q3', text: 'Which of these brands have you heard of? Select all.', type: 'multi', methodology: 'brand_health_tracker', funnel_stage: 'awareness', options: BRAND_OPTS },
  { id: 'q4', text: "Of the brands you've heard of, which would you consider buying next time you need software?", type: 'multi', methodology: 'brand_health_tracker', funnel_stage: 'consideration', options: BRAND_OPTS },
  { id: 'q5', text: "Of the brands you'd consider, if you had to choose ONE, which would you pick?", type: 'single', methodology: 'brand_health_tracker', funnel_stage: 'preference', options: BRAND_OPTS },
  { id: 'q6', text: 'Which of these brands do you use most often?', type: 'single', methodology: 'brand_health_tracker', funnel_stage: 'use', options: [...BRAND_OPTS, 'None of these'] },
  // NPS — focal via brand_id (lowercase on purpose: case-insensitive match)
  { id: 'q7a', text: 'How likely are you to recommend [Vett] to a friend or colleague?', type: 'rating', methodology: 'brand_health_tracker', funnel_stage: 'recommendation', brand_id: 'vett' },
  // NPS — competitor extension resolved from the question TEXT (brand_id null)
  { id: 'q7b', text: 'How likely are you to recommend [Acme] to a friend or colleague?', type: 'rating', methodology: 'brand_health_tracker', funnel_stage: 'recommendation', brand_id: null },
  // attribute matrix — funnel_stage="awareness" like q3, but options are
  // ATTRIBUTES; must not be mistaken for aided awareness
  { id: 'q8a', text: 'Which of these attributes apply to Vett? Select all that apply.', type: 'multi', methodology: 'brand_health_tracker', funnel_stage: 'awareness', brand_id: 'Vett', options: ['Affordable', 'Innovative'] },
  { id: 'q8b', text: 'Which of these attributes apply to Acme? Select all that apply.', type: 'multi', methodology: 'brand_health_tracker', funnel_stage: 'awareness', brand_id: null, options: ['Affordable', 'Innovative'] },
  { id: 'q9', text: 'How likely are you to switch from your current software to a different one in the next 6 months?', type: 'rating', methodology: 'brand_health_tracker', funnel_stage: 'switching' },
  { id: 'q10', text: 'If you were to switch, which brand would you most likely switch to?', type: 'single', methodology: 'brand_health_tracker', funnel_stage: 'switching', options: ['Acme', 'Zen'] },
  { id: 'q11', text: 'In the past 2 weeks, have you talked about Vett with friends, family, or colleagues?', type: 'single', methodology: 'brand_health_tracker', funnel_stage: 'wom', options: ['Yes - positively', 'Yes - negatively', "No, but I've thought about them", 'No, not at all'] },
];

const MISSION = { brand_name: 'Vett', competitor_brands: ['Acme', 'Zen'] };

/* Hand math (p1..p5, base 5 per question) —
 *   aided awareness q3: Vett {p1,p2,p4} 3/5=60%  Acme {p1,p2,p3,p5} 4/5=80%
 *                       Zen {p2,p4,p5} 3/5=60%
 *   consideration  q4: Vett 3/5=60%  Acme 2/5=40%  Zen 1/5=20%
 *   preference     q5: [Vett,Acme,Acme,Vett,Zen] → Vett 40% Acme 40% Zen 20%
 *   use            q6: [Vett,Acme,None of these,Vett,Zen] → Vett 40% Acme 20% Zen 20%
 *   NPS Vett  q7a [10,9,7,8,6]: promoters 2 (40%), passives 2 (40%),
 *             detractors 1 (20%) → score 40−20 = 20
 *   NPS Acme  q7b [9,6,5,8,3]: promoters 1 (20%), passives 1 (20%),
 *             detractors 3 (60%) → score 20−60 = −40
 *   attributes q8a Vett: Affordable {p1,p2,p4} 3/5=60%  Innovative {p2,p5} 2/5=40%
 *              q8b Acme: Affordable {p1,p3} 2/5=40%  Innovative {p1,p2,p3,p5} 4/5=80%
 *   gaps (focal − best competitor): Innovative 40−80 = −40 (focal trails),
 *        Affordable 60−40 = +20 → sorted ascending: Innovative first
 *   switching q9 [4,2,5,1,3] → mean 3.0, uniform distribution
 *             q10 [Acme,Acme,Zen,Acme,Zen] → Acme 60% Zen 40%
 *   wom q11: 'Yes - positively' ×2 → 40%
 */
const ROWS = [
  // q2 unaided (text — ignored by the math)
  row('p1', 'q2', 'Vett, Trello'), row('p2', 'q2', 'Acme'),
  // q3 aided awareness
  row('p1', 'q3', ['Vett', 'Acme']), row('p2', 'q3', ['Vett', 'Acme', 'Zen']),
  row('p3', 'q3', ['Acme']), row('p4', 'q3', ['Vett', 'Zen']), row('p5', 'q3', ['Acme', 'Zen']),
  // q4 consideration
  row('p1', 'q4', ['Vett']), row('p2', 'q4', ['Vett', 'Acme']), row('p3', 'q4', ['Acme']),
  row('p4', 'q4', ['Vett']), row('p5', 'q4', ['Zen']),
  // q5 preference
  row('p1', 'q5', 'Vett'), row('p2', 'q5', 'Acme'), row('p3', 'q5', 'Acme'),
  row('p4', 'q5', 'Vett'), row('p5', 'q5', 'Zen'),
  // q6 use
  row('p1', 'q6', 'Vett'), row('p2', 'q6', 'Acme'), row('p3', 'q6', 'None of these'),
  row('p4', 'q6', 'Vett'), row('p5', 'q6', 'Zen'),
  // q7a NPS Vett
  row('p1', 'q7a', 10), row('p2', 'q7a', 9), row('p3', 'q7a', 7), row('p4', 'q7a', 8), row('p5', 'q7a', 6),
  // q7b NPS Acme
  row('p1', 'q7b', 9), row('p2', 'q7b', 6), row('p3', 'q7b', 5), row('p4', 'q7b', 8), row('p5', 'q7b', 3),
  // q8a attributes Vett (empty array = answered, endorsed nothing)
  row('p1', 'q8a', ['Affordable']), row('p2', 'q8a', ['Affordable', 'Innovative']),
  row('p3', 'q8a', []), row('p4', 'q8a', ['Affordable']), row('p5', 'q8a', ['Innovative']),
  // q8b attributes Acme
  row('p1', 'q8b', ['Affordable', 'Innovative']), row('p2', 'q8b', ['Innovative']),
  row('p3', 'q8b', ['Affordable', 'Innovative']), row('p4', 'q8b', []), row('p5', 'q8b', ['Innovative']),
  // q9 switching intent
  row('p1', 'q9', 4), row('p2', 'q9', 2), row('p3', 'q9', 5), row('p4', 'q9', 1), row('p5', 'q9', 3),
  // q10 switching target
  row('p1', 'q10', 'Acme'), row('p2', 'q10', 'Acme'), row('p3', 'q10', 'Zen'),
  row('p4', 'q10', 'Acme'), row('p5', 'q10', 'Zen'),
  // q11 wom
  row('p1', 'q11', 'Yes - positively'), row('p2', 'q11', 'No, not at all'),
  row('p3', 'q11', 'Yes - positively'), row('p4', 'q11', 'Yes - negatively'),
  row('p5', 'q11', "No, but I've thought about them"),
];

const brand = (res, label) => res.brands.find((b) => b.brand_id === label);

test('brand funnel: aided awareness / consideration / preference / use shares with bases', () => {
  const res = computeCompetitor(ROWS, QUESTIONS, MISSION);
  expect(res.methodology).toBe('competitor');
  expect(res.n).toBe(5);
  expect(res.focal_brand).toBe('Vett');
  // ordered: focal first, then mission competitors
  expect(res.brands.map((b) => b.brand_id)).toEqual(['Vett', 'Acme', 'Zen']);
  expect(brand(res, 'Vett').is_focal).toBe(true);
  expect(brand(res, 'Acme').is_focal).toBe(false);

  expect(brand(res, 'Vett').awareness_pct).toEqual({ pct: 60, count: 3, base: 5 });
  expect(brand(res, 'Acme').awareness_pct).toEqual({ pct: 80, count: 4, base: 5 });
  expect(brand(res, 'Zen').awareness_pct).toEqual({ pct: 60, count: 3, base: 5 });

  expect(brand(res, 'Vett').consideration_pct).toEqual({ pct: 60, count: 3, base: 5 });
  expect(brand(res, 'Acme').consideration_pct).toEqual({ pct: 40, count: 2, base: 5 });
  expect(brand(res, 'Zen').consideration_pct).toEqual({ pct: 20, count: 1, base: 5 });

  expect(brand(res, 'Vett').preference_pct).toEqual({ pct: 40, count: 2, base: 5 });
  expect(brand(res, 'Vett').use_pct).toEqual({ pct: 40, count: 2, base: 5 });
  expect(brand(res, 'Acme').use_pct).toEqual({ pct: 20, count: 1, base: 5 });
});

test('NPS per brand: brand_id case-insensitive (focal) + question-text fallback (competitor)', () => {
  const res = computeCompetitor(ROWS, QUESTIONS, MISSION);
  // q7a brand_id='vett' (lowercase) → focal
  expect(brand(res, 'Vett').nps).toEqual({
    score: 20, promoters_pct: 40, passives_pct: 40, detractors_pct: 20, base: 5,
  });
  // q7b brand_id=null, text mentions [Acme]
  expect(brand(res, 'Acme').nps.score).toBe(-40);
  expect(brand(res, 'Acme').nps.detractors_pct).toBe(60);
  // no recommendation question resolved to Zen
  expect(brand(res, 'Zen').nps).toBeNull();
});

test('attribute battery: brand × attribute endorsement %, not confused with aided awareness', () => {
  const res = computeCompetitor(ROWS, QUESTIONS, MISSION);
  expect(brand(res, 'Vett').attributes).toEqual({ Affordable: 60, Innovative: 40 });
  expect(brand(res, 'Vett').attributes_base).toBe(5);
  expect(brand(res, 'Acme').attributes).toEqual({ Affordable: 40, Innovative: 80 });
  expect(brand(res, 'Zen').attributes).toBeNull();
  // q8a/q8b selections must NOT leak into aided awareness (q3 stays base-5 counts)
  expect(brand(res, 'Vett').awareness_pct.count).toBe(3);
});

test('gaps: focal vs best competitor per attribute, negative = focal trails, worst first', () => {
  const res = computeCompetitor(ROWS, QUESTIONS, MISSION);
  expect(res.gaps).toEqual([
    { attribute: 'Innovative', focal_mean: 40, best_competitor: 'Acme', best_competitor_mean: 80, gap: -40 },
    { attribute: 'Affordable', focal_mean: 60, best_competitor: 'Acme', best_competitor_mean: 40, gap: 20 },
  ]);
});

test('share of preference, switching intent + destinations, WoM distribution', () => {
  const res = computeCompetitor(ROWS, QUESTIONS, MISSION);
  expect(res.share_of_preference.base).toBe(5);
  expect(res.share_of_preference.shares.Vett).toEqual({ count: 2, pct: 40 });
  expect(res.share_of_preference.shares.Zen).toEqual({ count: 1, pct: 20 });

  expect(res.switching.intent_distribution.base).toBe(5);
  expect(res.switching.intent_distribution.stats.mean).toBe(3);
  expect(res.switching.intent_distribution.distribution).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 });
  expect(res.switching.destinations.base).toBe(5);
  expect(res.switching.destinations.shares.Acme).toEqual({ count: 3, pct: 60 });
  expect(res.switching.destinations.shares.Zen).toEqual({ count: 2, pct: 40 });

  expect(res.wom.base).toBe(5);
  expect(res.wom.shares['Yes - positively']).toEqual({ count: 2, pct: 40 });
});

test('mission.competitor_brands as a JSON string (TEXT/JSONB round-trip) parses', () => {
  const res = computeCompetitor(ROWS, QUESTIONS, {
    brand_name: 'Vett',
    competitor_brands: '["Acme","Zen"]',
  });
  expect(res.brands.map((b) => b.brand_id)).toEqual(['Vett', 'Acme', 'Zen']);
  expect(brand(res, 'Acme').awareness_pct.pct).toBe(80);
});

test('NPS guard: a rating outside 0-10 means it is not an NPS scale → null, never a wrong score', () => {
  const qs = [{ id: 'qx', text: 'How likely are you to recommend [Vett]?', type: 'rating', funnel_stage: 'recommendation', brand_id: 'Vett' }];
  const rows = [row('p1', 'qx', 14), row('p2', 'qx', 9)];
  const res = computeCompetitor(rows, qs, MISSION);
  expect(brand(res, 'Vett').nps).toBeNull();
});

test('incomputable → null, never throw (empty + junk inputs)', () => {
  const empty = computeCompetitor([], [], null);
  expect(empty).toEqual({
    methodology: 'competitor',
    n: 0,
    focal_brand: null,
    brands: [],
    share_of_preference: null,
    switching: null,
    wom: null,
    gaps: null,
  });
  expect(() => computeCompetitor('junk', { not: 'an array' }, 3)).not.toThrow();

  // mission known but zero responses → brands listed with null metrics
  const noRows = computeCompetitor([], QUESTIONS, MISSION);
  expect(noRows.brands.map((b) => b.brand_id)).toEqual(['Vett', 'Acme', 'Zen']);
  expect(noRows.brands[0].awareness_pct).toBeNull();
  expect(noRows.brands[0].nps).toBeNull();
  expect(noRows.gaps).toBeNull();
  expect(noRows.switching).toBeNull();
});

// ── PASS 47 — NEW GENERATOR SHAPE: per-brand attribute batteries ──────────
// The fixed generator emits ONE attribute battery PER BRAND (focal + each
// competitor), all funnel_stage="attributes", IDENTICAL options, brand_id
// set per brand (focal = "our_brand"). This mirrors the radar-enabling
// shape and the WORST anchoring case from real mission
// 4515fed5-7c3d-4c47-912b-d54b07ba31de: a GENERIC focal — mission.brand_name
// is null and competitor_brands is empty, so the focal brand is identified
// ONLY by the brand_id="our_brand" convention + the aided-awareness option
// "Our Brand". Three brands share the same 3-attribute battery, so the radar
// has shared axes across ≥2 brands and gaps compute.
const NEW_BRAND_OPTS = ['Our Brand', 'Careem', 'Uber'];
const NEW_ATTRS = ['Reliable', 'Affordable', 'Modern'];

const NEW_QUESTIONS = [
  { id: 'q1', text: 'How often do you take ride-hailing trips?', type: 'single', isScreening: true, methodology: 'brand_health_tracker', funnel_stage: 'screener', brand_id: null, options: ['Weekly', 'Never'] },
  { id: 'q2', text: 'Which ride-hailing brands come to mind? List up to 5.', type: 'text', methodology: 'brand_health_tracker', funnel_stage: 'awareness', brand_id: null, options: [] },
  { id: 'q3', text: 'Which of these ride-hailing brands have you heard of? Select all.', type: 'multi', methodology: 'brand_health_tracker', funnel_stage: 'awareness', brand_id: null, options: NEW_BRAND_OPTS },
  { id: 'q4', text: 'Which of these would you consider next time? Select all.', type: 'multi', methodology: 'brand_health_tracker', funnel_stage: 'consideration', brand_id: null, options: NEW_BRAND_OPTS },
  { id: 'q5', text: 'If you had to choose ONE for your next ride, which would you pick?', type: 'single', methodology: 'brand_health_tracker', funnel_stage: 'preference', brand_id: null, options: NEW_BRAND_OPTS },
  { id: 'q6', text: 'Which ride-hailing brand do you use most often?', type: 'single', methodology: 'brand_health_tracker', funnel_stage: 'use', brand_id: null, options: [...NEW_BRAND_OPTS, 'None of these'] },
  // NPS — focal via brand_id="our_brand" convention (generic focal: no brand_name)
  { id: 'q7', text: 'How likely are you to recommend Our Brand to a friend? (0-10)', type: 'rating', methodology: 'brand_health_tracker', funnel_stage: 'recommendation', brand_id: 'our_brand', options: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'] },
  // attribute batteries — funnel_stage="attributes", IDENTICAL options, one per brand
  { id: 'q8_focal', text: 'Which of these attributes apply to Our Brand? Select all that apply.', type: 'multi', methodology: 'brand_health_tracker', funnel_stage: 'attributes', brand_id: 'our_brand', options: NEW_ATTRS },
  { id: 'q8_careem', text: 'Which of these attributes apply to Careem? Select all that apply.', type: 'multi', methodology: 'brand_health_tracker', funnel_stage: 'attributes', brand_id: 'Careem', options: NEW_ATTRS },
  { id: 'q8_uber', text: 'Which of these attributes apply to Uber? Select all that apply.', type: 'multi', methodology: 'brand_health_tracker', funnel_stage: 'attributes', brand_id: 'Uber', options: NEW_ATTRS },
  { id: 'q9', text: 'How likely are you to switch brands in the next 6 months? (1-5)', type: 'rating', methodology: 'brand_health_tracker', funnel_stage: 'switching', brand_id: null, options: ['1', '2', '3', '4', '5'] },
  { id: 'q10', text: 'If you were to switch, which brand would you most likely switch to?', type: 'single', methodology: 'brand_health_tracker', funnel_stage: 'switching', brand_id: null, options: ['Careem', 'Uber'] },
  { id: 'q11', text: 'In the past 2 weeks, have you talked about Our Brand with others?', type: 'single', methodology: 'brand_health_tracker', funnel_stage: 'wom', brand_id: 'our_brand', options: ['Yes - positively', 'Yes - negatively', "No, but I've thought about them", 'No, not at all'] },
];

// Generic focal — exactly the real-mission failure mode (brand_name null).
const NEW_MISSION = { brand_name: null, competitor_brands: [] };

/* Hand math (p1..p5, base 5) —
 *   preference q5: [Our Brand, Careem, Uber, Careem, Uber]
 *                  → Our Brand 20%  Careem 40%  Uber 40%  (sums to 100%)
 *   attributes (shared battery Reliable/Affordable/Modern):
 *     Our Brand q8_focal:  Reliable {p1,p2,p3} 60%  Affordable {p1} 20%  Modern {p1,p2} 40%
 *     Careem    q8_careem: Reliable {p1,p2} 40%     Affordable {p1,p2,p3,p4} 80%  Modern {p3} 20%
 *     Uber      q8_uber:   Reliable {p1..p5} 100%   Affordable {p1} 20%  Modern {p1,p2,p3,p4} 80%
 *   gaps (focal − best competitor):
 *     Reliable  60 − 100(Uber)  = −40
 *     Affordable 20 − 80(Careem) = −60
 *     Modern    40 − 80(Uber)   = −40
 *     sorted ascending (gap, then attr name): Affordable −60, Modern −40, Reliable −40
 *   NPS focal q7 [10,9,8,6,5]: promoters 2 (40%), passives 1 (20%),
 *             detractors 2 (40%) → score 40−40 = 0
 */
const NEW_ROWS = [
  // q3 aided (so focal anchoring also works off the first option)
  row('p1', 'q3', ['Our Brand', 'Careem', 'Uber']), row('p2', 'q3', ['Careem', 'Uber']),
  row('p3', 'q3', ['Uber']), row('p4', 'q3', ['Careem', 'Uber']), row('p5', 'q3', ['Uber']),
  // q5 preference
  row('p1', 'q5', 'Our Brand'), row('p2', 'q5', 'Careem'), row('p3', 'q5', 'Uber'),
  row('p4', 'q5', 'Careem'), row('p5', 'q5', 'Uber'),
  // q7 NPS focal
  row('p1', 'q7', 10), row('p2', 'q7', 9), row('p3', 'q7', 8), row('p4', 'q7', 6), row('p5', 'q7', 5),
  // q8_focal attributes — Our Brand
  row('p1', 'q8_focal', ['Reliable', 'Affordable', 'Modern']), row('p2', 'q8_focal', ['Reliable', 'Modern']),
  row('p3', 'q8_focal', ['Reliable']), row('p4', 'q8_focal', []), row('p5', 'q8_focal', []),
  // q8_careem attributes — Careem
  row('p1', 'q8_careem', ['Reliable', 'Affordable']), row('p2', 'q8_careem', ['Reliable', 'Affordable']),
  row('p3', 'q8_careem', ['Affordable', 'Modern']), row('p4', 'q8_careem', ['Affordable']), row('p5', 'q8_careem', []),
  // q8_uber attributes — Uber
  row('p1', 'q8_uber', ['Reliable', 'Affordable', 'Modern']), row('p2', 'q8_uber', ['Reliable', 'Modern']),
  row('p3', 'q8_uber', ['Reliable', 'Modern']), row('p4', 'q8_uber', ['Reliable', 'Modern']), row('p5', 'q8_uber', ['Reliable']),
  // q10 switching target
  row('p1', 'q10', 'Careem'), row('p2', 'q10', 'Careem'), row('p3', 'q10', 'Uber'),
  row('p4', 'q10', 'Careem'), row('p5', 'q10', 'Uber'),
];

test('NEW shape: generic focal anchored via brand_id="our_brand" convention', () => {
  const res = computeCompetitor(NEW_ROWS, NEW_QUESTIONS, NEW_MISSION);
  // §2.3 — mission.brand_name is null; the focal battery still ANCHORS via the
  // brand_id="our_brand" convention (brand_id stays "Our Brand" as the internal
  // key), but the DISPLAY label must never be the "Our Brand" placeholder.
  expect(res.focal_brand).toBe('the brand');
  expect(brand(res, 'Our Brand').is_focal).toBe(true);   // anchored via brand_id
  expect(brand(res, 'Our Brand').label).toBe('the brand'); // display relabeled
  expect(res.brands.some((b) => b.label === 'Our Brand')).toBe(false);
  expect(brand(res, 'Careem').is_focal).toBe(false);
  expect(brand(res, 'Uber').is_focal).toBe(false);
  // focal NPS resolves through the convention even with a generic focal
  expect(brand(res, 'Our Brand').nps).toEqual({
    score: 0, promoters_pct: 40, passives_pct: 20, detractors_pct: 40, base: 5,
  });
});

test('NEW shape: radar — ≥2 brands scored on the SAME shared attribute axes', () => {
  const res = computeCompetitor(NEW_ROWS, NEW_QUESTIONS, NEW_MISSION);
  const withAttrs = res.brands.filter((b) => b.attributes);
  // all three brands carry attribute data (radar needs ≥2)
  expect(withAttrs.map((b) => b.brand_id)).toEqual(['Our Brand', 'Careem', 'Uber']);
  // axes are shared: identical key set across every brand
  const axes = (b) => Object.keys(b.attributes).sort();
  expect(axes(brand(res, 'Our Brand'))).toEqual(['Affordable', 'Modern', 'Reliable']);
  expect(axes(brand(res, 'Careem'))).toEqual(['Affordable', 'Modern', 'Reliable']);
  expect(axes(brand(res, 'Uber'))).toEqual(['Affordable', 'Modern', 'Reliable']);
  // endorsement % per the hand math
  expect(brand(res, 'Our Brand').attributes).toEqual({ Reliable: 60, Affordable: 20, Modern: 40 });
  expect(brand(res, 'Careem').attributes).toEqual({ Reliable: 40, Affordable: 80, Modern: 20 });
  expect(brand(res, 'Uber').attributes).toEqual({ Reliable: 100, Affordable: 20, Modern: 80 });
  expect(brand(res, 'Our Brand').attributes_base).toBe(5);
});

test('NEW shape: share-of-preference maps brand-name answers, sums to 100% over brands', () => {
  const res = computeCompetitor(NEW_ROWS, NEW_QUESTIONS, NEW_MISSION);
  expect(res.share_of_preference.question_id).toBe('q5');
  expect(res.share_of_preference.base).toBe(5);
  const sh = res.share_of_preference.shares;
  expect(sh['Our Brand']).toEqual({ count: 1, pct: 20 });
  expect(sh.Careem).toEqual({ count: 2, pct: 40 });
  expect(sh.Uber).toEqual({ count: 2, pct: 40 });
  const totalPct = Object.values(sh).reduce((s, v) => s + v.pct, 0);
  expect(totalPct).toBe(100);
});

test('NEW shape: gaps — focal vs best competitor per attribute, worst deficit first', () => {
  const res = computeCompetitor(NEW_ROWS, NEW_QUESTIONS, NEW_MISSION);
  // focal(Our Brand) − best competitor per attribute:
  //   Affordable 20 − 80(Careem) = −60  (worst → first)
  //   Modern     40 − 80(Uber)   = −40  ("Modern" < "Reliable" on the tie)
  //   Reliable   60 − 100(Uber)  = −40
  expect(res.gaps).toEqual([
    { attribute: 'Affordable', focal_mean: 20, best_competitor: 'Careem', best_competitor_mean: 80, gap: -60 },
    { attribute: 'Modern', focal_mean: 40, best_competitor: 'Uber', best_competitor_mean: 80, gap: -40 },
    { attribute: 'Reliable', focal_mean: 60, best_competitor: 'Uber', best_competitor_mean: 100, gap: -40 },
  ]);
});

test('NEW shape: attribute batteries are NOT mistaken for aided awareness (q3 stays brand-based)', () => {
  const res = computeCompetitor(NEW_ROWS, NEW_QUESTIONS, NEW_MISSION);
  // aided awareness still reads from q3 (brand options), not the batteries:
  // Uber heard-of by all 5 personas → 100%
  expect(brand(res, 'Uber').awareness_pct).toEqual({ pct: 100, count: 5, base: 5 });
  expect(brand(res, 'Our Brand').awareness_pct).toEqual({ pct: 20, count: 1, base: 5 });
});
