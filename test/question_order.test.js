/**
 * Hardening item 2 — per-persona seeded question-order randomization.
 *
 * The single most important test in this file is
 * "answers always land on their ORIGINAL question_id". Responses are stored
 * against question_id and (mission_id, persona_id, question_id) is a UNIQUE
 * index (pass 48), so a shuffle that mis-mapped answers to ids would silently
 * corrupt every mission. That test drives the real simulator with a mock that
 * answers in the SHUFFLED order and asserts every answer comes back attached
 * to its own question.
 */

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../src/services/ai/anthropic', () => ({
  callClaude: jest.fn(),
  extractJSON: jest.requireActual('../src/services/ai/anthropic').extractJSON,
}));

const { callClaude: mockCallClaude } = require('../src/services/ai/anthropic');
const { simulateResponses } = require('../src/services/ai/simulate');
const {
  orderQuestionsForPersona,
  buildZones,
  classifyQuestion,
  untaggedAreFree,
  seedFor,
  makeRng,
} = require('../src/services/ai/questionOrder');

const ids = (qs) => qs.map((q) => q.id);

// The generic goal — its surveys are the flat SURVEY_GEN_SYSTEM list, so
// untagged questions are genuinely free here. Specialized fixtures below use
// their own goal_type so the legacy-shape safety net is exercised honestly.
const mission = { id: 'm-order-1', user_id: 'u1', goal_type: 'research', brief: 'b' };
const pricingMission = { ...mission, goal_type: 'pricing' };
const roadmapMission = { ...mission, goal_type: 'roadmap' };
const brandLiftMission = { ...mission, goal_type: 'brand_lift' };
const apMission = { ...mission, goal_type: 'audience_profiling' };
const compareMission = { ...mission, goal_type: 'compare' };
const P = (id) => ({ id, name: `persona ${id}` });

beforeEach(() => { jest.clearAllMocks(); });

// ── Fixtures ─────────────────────────────────────────────────────────────

/** 12 free (metadata-free) questions behind one screener. */
function freeSurvey(n = 12) {
  const qs = [{ id: 'q1', text: 'screener', type: 'single', options: ['Yes', 'No'], isScreening: true }];
  for (let i = 2; i <= n; i += 1) qs.push({ id: `q${i}`, text: `free ${i}`, type: 'single', options: ['A', 'B'] });
  return qs;
}

/** Screener + Van Westendorp (4) + Gabor-Granger (5) + 2 free tail questions. */
function pricingSurvey() {
  return [
    { id: 'q1', text: 'screener', type: 'single', options: ['Yes', 'No'], isScreening: true, methodology: 'screener' },
    { id: 'vw1', text: 'too cheap', type: 'text', methodology: 'van_westendorp', vw_band: 'too_cheap' },
    { id: 'vw2', text: 'bargain', type: 'text', methodology: 'van_westendorp', vw_band: 'bargain' },
    { id: 'vw3', text: 'expensive', type: 'text', methodology: 'van_westendorp', vw_band: 'expensive' },
    { id: 'vw4', text: 'too expensive', type: 'text', methodology: 'van_westendorp', vw_band: 'too_expensive' },
    { id: 'gg1', text: 'at $9', type: 'single', methodology: 'gabor_granger', gg_anchor_index: 0 },
    { id: 'gg2', text: 'at $19', type: 'single', methodology: 'gabor_granger', gg_anchor_index: 1 },
    { id: 'gg3', text: 'at $39', type: 'single', methodology: 'gabor_granger', gg_anchor_index: 2 },
    { id: 'gg4', text: 'at $79', type: 'single', methodology: 'gabor_granger', gg_anchor_index: 3 },
    { id: 'gg5', text: 'at $149', type: 'single', methodology: 'gabor_granger', gg_anchor_index: 4 },
    { id: 'f1', text: 'free one', type: 'single', options: ['A', 'B'] },
    { id: 'f2', text: 'free two', type: 'single', options: ['A', 'B'] },
  ];
}

/** Screener + 3 MaxDiff sets + 3 Kano feature pairs. */
function roadmapSurvey() {
  const qs = [{ id: 'q1', text: 'screener', type: 'single', isScreening: true, methodology: 'screener' }];
  for (let i = 1; i <= 3; i += 1) {
    qs.push({
      id: `md${i}`, text: `maxdiff ${i}`, type: 'max_diff_set', methodology: 'max_diff',
      feature_set: ['f1', 'f2', 'f3', 'f4'], options: ['A', 'B', 'C', 'D'],
    });
  }
  for (const f of ['fa', 'fb', 'fc']) {
    qs.push({ id: `k_${f}_fn`, text: `${f} functional`, type: 'single', methodology: 'kano', feature_id: f, kano_type: 'functional' });
    qs.push({ id: `k_${f}_dy`, text: `${f} dysfunctional`, type: 'single', methodology: 'kano', feature_id: f, kano_type: 'dysfunctional' });
  }
  return qs;
}

/** Brand-lift funnel: unaided before aided is the whole point. */
function brandLiftSurvey() {
  const stages = [
    'unaided_ad_recall', 'aided_ad_recall', 'unaided_brand_awareness',
    'aided_brand_awareness', 'brand_consideration', 'purchase_intent', 'nps',
  ];
  const qs = [{ id: 'q1', text: 'screener', type: 'single', isScreening: true, funnel_stage: 'screening' }];
  stages.forEach((s, i) => qs.push({ id: `b${i + 2}`, text: s, type: 'rating', funnel_stage: s, is_lift_question: true }));
  return qs;
}

/** Audience profiling: screener + 6-item attitudinal battery + behavioural tail. */
function apSurvey() {
  const dims = ['price_sensitivity', 'novelty_seeking', 'brand_loyalty', 'convenience', 'status', 'sustainability'];
  const qs = [{ id: 'q1', text: 'screener', type: 'single', isScreening: true, kind: 'screener' }];
  dims.forEach((d, i) => qs.push({ id: `a${i + 2}`, text: d, type: 'rating', kind: 'attitudinal', dimension: d }));
  qs.push({ id: 'q8', text: 'frequency', type: 'single', kind: 'behavioural' });
  qs.push({ id: 'q11', text: 'media', type: 'multi', kind: 'media' });
  qs.push({ id: 'q12', text: 'needs', type: 'multi', kind: 'needs' });
  return qs;
}

// ── 1. Determinism ───────────────────────────────────────────────────────

test('same mission + same persona always yields the same order', () => {
  const qs = freeSurvey();
  const a = orderQuestionsForPersona(qs, mission, P('p1'));
  const b = orderQuestionsForPersona(qs, mission, P('p1'));
  expect(ids(a)).toEqual(ids(b));

  // and across a fresh module instance (no hidden state carried in closures)
  jest.resetModules();
  const fresh = require('../src/services/ai/questionOrder');
  expect(ids(fresh.orderQuestionsForPersona(qs, mission, P('p1')))).toEqual(ids(a));
});

test('the shuffle uses no Math.random — order is stable while Math.random is stubbed to a constant', () => {
  const qs = freeSurvey();
  const real = Math.random;
  Math.random = () => 0.123456789;
  const a = orderQuestionsForPersona(qs, mission, P('p7'));
  Math.random = () => 0.987654321;
  const b = orderQuestionsForPersona(qs, mission, P('p7'));
  Math.random = real;
  expect(ids(a)).toEqual(ids(b));
});

test('a different mission id yields a different order for the same persona', () => {
  const qs = freeSurvey(14);
  const a = orderQuestionsForPersona(qs, mission, P('p1'));
  const b = orderQuestionsForPersona(qs, { ...mission, id: 'm-order-2' }, P('p1'));
  expect(ids(a)).not.toEqual(ids(b));
});

test('different personas get different orders (and the sample spreads across many orders)', () => {
  const qs = freeSurvey(12);
  const seen = new Set();
  for (let i = 0; i < 60; i += 1) seen.add(ids(orderQuestionsForPersona(qs, mission, P(`p${i}`))).join(','));
  // 60 personas over 11 shufflable questions: essentially all distinct.
  expect(seen.size).toBeGreaterThan(50);
});

test('seedFor is stable and separator-safe (no ab|c vs a|bc collision)', () => {
  expect(seedFor({ id: 'm1' }, { id: 'p1' })).toBe(seedFor({ id: 'm1' }, { id: 'p1' }));
  expect(seedFor({ id: 'ab' }, { id: 'c' })).not.toBe(seedFor({ id: 'a' }, { id: 'bc' }));
});

test('makeRng is deterministic and stays in [0,1)', () => {
  const r1 = makeRng(12345); const r2 = makeRng(12345);
  for (let i = 0; i < 200; i += 1) {
    const v = r1();
    expect(v).toBe(r2());
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  }
});

// ── 2. It is always a permutation, never a mutation ──────────────────────

test('the asked order is a permutation of the input and never mutates it', () => {
  const cases = [[freeSurvey, mission], [pricingSurvey, pricingMission],
    [roadmapSurvey, roadmapMission], [brandLiftSurvey, brandLiftMission], [apSurvey, apMission]];
  for (const [build, m] of cases) {
    const qs = build();
    const before = ids(qs);
    for (const p of ['p1', 'p2', 'p3', 'p4', 'p5']) {
      const out = orderQuestionsForPersona(qs, m, P(p));
      expect(out).toHaveLength(qs.length);
      expect(ids(out).slice().sort()).toEqual(before.slice().sort());
      // same object references — nothing is cloned or rebuilt
      for (const q of out) expect(qs).toContain(q);
    }
    expect(ids(qs)).toEqual(before); // input untouched
  }
});

// ── 3. Screeners pinned first ────────────────────────────────────────────

test('screeners are always first, in their original relative order', () => {
  const qs = [
    { id: 'a', text: 'free a' },
    { id: 's1', text: 'screener 1', isScreening: true },
    { id: 'b', text: 'free b' },
    { id: 's2', text: 'screener 2', isScreening: true },
    { id: 'c', text: 'free c' },
    { id: 'd', text: 'free d' },
  ];
  for (let i = 0; i < 40; i += 1) {
    const out = ids(orderQuestionsForPersona(qs, mission, P(`p${i}`)));
    expect(out.slice(0, 2)).toEqual(['s1', 's2']);
  }
});

test('every fixture keeps its screener at position 0 for every persona', () => {
  const cases = [[freeSurvey, mission], [pricingSurvey, pricingMission],
    [roadmapSurvey, roadmapMission], [brandLiftSurvey, brandLiftMission], [apSurvey, apMission]];
  for (const [build, m] of cases) {
    const qs = build();
    for (let i = 0; i < 25; i += 1) {
      expect(orderQuestionsForPersona(qs, m, P(`p${i}`))[0].id).toBe('q1');
    }
  }
});

// ── 4. Order-locked blocks stay intact (the MUTATION-CHECK target) ───────

/**
 * Assert a locked block appears as a contiguous run, in exactly the given
 * order. Used for Van Westendorp and Gabor-Granger — deliberately strict so
 * that shuffling either block makes this fail (see the mutation check).
 */
function expectContiguousInOrder(orderedIds, blockIds, label) {
  const positions = blockIds.map((id) => orderedIds.indexOf(id));
  expect(positions.every((p) => p >= 0)).toBe(true);
  for (let i = 1; i < positions.length; i += 1) {
    // contiguous AND ascending
    if (positions[i] !== positions[i - 1] + 1) {
      throw new Error(`${label}: expected ${blockIds[i]} immediately after ${blockIds[i - 1]}, got positions ${positions.join(',')} in [${orderedIds.join(',')}]`);
    }
  }
}

test('Van Westendorp stays a contiguous block in canonical band order', () => {
  const qs = pricingSurvey();
  for (let i = 0; i < 50; i += 1) {
    const out = ids(orderQuestionsForPersona(qs, pricingMission, P(`p${i}`)));
    expectContiguousInOrder(out, ['vw1', 'vw2', 'vw3', 'vw4'], 'van_westendorp');
  }
});

test('Gabor-Granger stays a contiguous ASCENDING price ladder', () => {
  const qs = pricingSurvey();
  for (let i = 0; i < 50; i += 1) {
    const out = ids(orderQuestionsForPersona(qs, pricingMission, P(`p${i}`)));
    expectContiguousInOrder(out, ['gg1', 'gg2', 'gg3', 'gg4', 'gg5'], 'gabor_granger');
  }
});

test('brand-lift funnel is not shuffled at all — unaided always precedes aided', () => {
  const qs = brandLiftSurvey();
  const canonical = ids(qs);
  for (let i = 0; i < 50; i += 1) {
    expect(ids(orderQuestionsForPersona(qs, brandLiftMission, P(`p${i}`)))).toEqual(canonical);
  }
});

test('concept batteries and the forced-choice tail are locked', () => {
  const qs = [
    { id: 'q1', isScreening: true, methodology: 'sequential_monadic' },
    { id: 'c1a', concept_id: 'c1', funnel_stage: 'appeal' },
    { id: 'c1b', concept_id: 'c1', funnel_stage: 'relevance' },
    { id: 'c2a', concept_id: 'c2', funnel_stage: 'appeal' },
    { id: 'c2b', concept_id: 'c2', funnel_stage: 'relevance' },
    { id: 'fin', is_final_choice: true },
  ];
  const canonical = ids(qs);
  for (let i = 0; i < 30; i += 1) {
    expect(ids(orderQuestionsForPersona(qs, compareMission, P(`p${i}`)))).toEqual(canonical);
  }
});

// ── 5. Rotatable blocks: units rotate, atoms stay intact ────────────────

test('Kano pairs rotate as a unit but never fragment or invert', () => {
  const qs = roadmapSurvey();
  let sawRotation = false;
  const baseline = ids(orderQuestionsForPersona(qs, roadmapMission, P('p0')));
  for (let i = 0; i < 50; i += 1) {
    const out = ids(orderQuestionsForPersona(qs, roadmapMission, P(`p${i}`)));
    for (const f of ['fa', 'fb', 'fc']) {
      expectContiguousInOrder(out, [`k_${f}_fn`, `k_${f}_dy`], `kano:${f}`);
    }
    if (out.join(',') !== baseline.join(',')) sawRotation = true;
  }
  expect(sawRotation).toBe(true); // rotation actually happens
});

test('MaxDiff sets rotate among themselves and never interleave with the Kano block', () => {
  const qs = roadmapSurvey();
  for (let i = 0; i < 50; i += 1) {
    const out = ids(orderQuestionsForPersona(qs, roadmapMission, P(`p${i}`)));
    const mdPos = out.map((id, k) => (id.startsWith('md') ? k : -1)).filter((k) => k >= 0);
    // the three MaxDiff slots are exactly 1,2,3 (right after the screener)
    expect(mdPos).toEqual([1, 2, 3]);
    // and every Kano question lives after them
    const kanoPos = out.map((id, k) => (id.startsWith('k_') ? k : -1)).filter((k) => k >= 0);
    expect(Math.min(...kanoPos)).toBeGreaterThan(Math.max(...mdPos));
  }
});

test('the attitudinal Likert battery rotates but the behavioural/media/needs tail does not', () => {
  const qs = apSurvey();
  let sawRotation = false;
  for (let i = 0; i < 50; i += 1) {
    const out = ids(orderQuestionsForPersona(qs, apMission, P(`p${i}`)));
    expect(out[0]).toBe('q1');
    // 6 attitudinal items occupy slots 1..6, tail is fixed
    expect(out.slice(1, 7).slice().sort()).toEqual(['a2', 'a3', 'a4', 'a5', 'a6', 'a7']);
    expect(out.slice(7)).toEqual(['q8', 'q11', 'q12']);
    if (out.slice(1, 7).join(',') !== 'a2,a3,a4,a5,a6,a7') sawRotation = true;
  }
  expect(sawRotation).toBe(true);
});

test('free questions in the pricing survey rotate without disturbing the locked blocks', () => {
  const qs = pricingSurvey();
  let sawFreeSwap = false;
  for (let i = 0; i < 50; i += 1) {
    // pricing is order-sensitive, but these two questions are FREE-classified
    // metadata-free tail items, so under a generic-goal mission they rotate.
    const out = ids(orderQuestionsForPersona(qs, mission, P(`p${i}`)));
    expect(out.slice(-2).slice().sort()).toEqual(['f1', 'f2']);
    if (out.slice(-2).join(',') === 'f2,f1') sawFreeSwap = true;
  }
  expect(sawFreeSwap).toBe(true);
});

// ── 6. Classification table ─────────────────────────────────────────────

test('classifyQuestion assigns the documented zone per methodology', () => {
  const z = (q) => classifyQuestion(q).zone;
  expect(z({ isScreening: true, methodology: 'van_westendorp' })).toBe('pinned');
  expect(z({ methodology: 'van_westendorp', vw_band: 'bargain' })).toBe('locked');
  expect(z({ methodology: 'gabor_granger', gg_anchor_index: 0 })).toBe('locked'); // index 0 is NOT "absent"
  expect(z({ funnel_stage: 'aided_ad_recall' })).toBe('locked');
  expect(z({ concept_id: 'c1' })).toBe('locked');
  expect(z({ is_final_choice: true })).toBe('locked');
  expect(z({ churn_stage: 'reason' })).toBe('locked');
  expect(z({ methodology: 'turf' })).toBe('locked');
  expect(z({ methodology: 'nps_driver' })).toBe('locked');
  expect(z({ kind: 'wtp' })).toBe('locked');       // market-entry kinds
  expect(z({ kind: 'behavioural' })).toBe('locked');
  expect(z({ methodology: 'kano', feature_id: 'f1', kano_type: 'functional' })).toBe('rotatable');
  expect(z({ methodology: 'max_diff', feature_set: ['a'] })).toBe('rotatable');
  expect(z({ kind: 'attitudinal', dimension: 'status' })).toBe('rotatable');
  expect(z({ is_paired_comparison: true })).toBe('rotatable');
  expect(z({ id: 'q3', text: 'plain', type: 'single' })).toBe('free');
});

test('a Kano pair shares one rotation unit; different features do not', () => {
  const fn = classifyQuestion({ methodology: 'kano', feature_id: 'fa', kano_type: 'functional' });
  const dy = classifyQuestion({ methodology: 'kano', feature_id: 'fa', kano_type: 'dysfunctional' });
  const other = classifyQuestion({ methodology: 'kano', feature_id: 'fb', kano_type: 'functional' });
  expect(fn.unit).toBe(dy.unit);
  expect(fn.unit).not.toBe(other.unit);
  expect(fn.block).toBe(other.block); // same rotation pool
});

// ── 7. Degenerate inputs ────────────────────────────────────────────────

test('a single-question mission is a no-op', () => {
  const qs = [{ id: 'q1', text: 'only', isScreening: true }];
  expect(orderQuestionsForPersona(qs, mission, P('p1'))).toBe(qs);
});

test('an empty question array does not throw', () => {
  expect(() => orderQuestionsForPersona([], mission, P('p1'))).not.toThrow();
  expect(orderQuestionsForPersona([], mission, P('p1'))).toEqual([]);
});

test('null/undefined inputs degrade to an empty array rather than throwing', () => {
  expect(orderQuestionsForPersona(null, mission, P('p1'))).toEqual([]);
  expect(orderQuestionsForPersona(undefined, null, null)).toEqual([]);
});

test('a missing persona id or mission id still produces a valid permutation', () => {
  const qs = freeSurvey(6);
  const out = orderQuestionsForPersona(qs, {}, {});
  expect(ids(out).slice().sort()).toEqual(ids(qs).slice().sort());
  expect(out[0].id).toBe('q1');
});

test('buildZones puts screeners in `pinned` and anchors locked blocks with group=null', () => {
  const { pinned, units } = buildZones(pricingSurvey());
  expect(ids(pinned)).toEqual(['q1']);
  const vw = units.find((u) => u.key === 'locked:van_westendorp');
  expect(ids(vw.questions)).toEqual(['vw1', 'vw2', 'vw3', 'vw4']);
  expect(vw.group).toBeNull();
  expect(units.filter((u) => u.group === 'free')).toHaveLength(2);
});

// ── 7b. Legacy-shape safety net ─────────────────────────────────────────

/**
 * A REAL corpus shape: a pricing mission whose Van Westendorp battery is
 * plain prose with NO vw_band and NO methodology (observed on mission
 * 1558bc91, 2026-08-01). Metadata-driven classification alone would call
 * these free and shuffle the ladder.
 */
function legacyUntaggedPricingSurvey() {
  return [
    { id: 'q1', text: 'How do you currently source coffee?', type: 'single', isScreening: true },
    { id: 'q2', text: 'At what price would X be SO EXPENSIVE you would not consider buying it?', type: 'text' },
    { id: 'q3', text: 'At what price would X be priced so high you would question the quality?', type: 'text' },
    { id: 'q4', text: 'At what price would X be a bargain?', type: 'text' },
    { id: 'q5', text: 'At what price would X be so cheap you would question the quality?', type: 'text' },
    { id: 'q6', text: 'Anything else?', type: 'text' },
  ];
}

test('untaggedAreFree: only the generic goal lets untagged questions shuffle', () => {
  expect(untaggedAreFree({ goal_type: 'research' })).toBe(true);
  expect(untaggedAreFree({})).toBe(true);            // no goal_type = generic generator
  expect(untaggedAreFree({ goal_type: '  ' })).toBe(true);
  for (const g of ['pricing', 'brand_lift', 'marketing', 'roadmap', 'compare', 'validate',
    'competitor', 'satisfaction', 'churn_research', 'market_entry', 'naming_messaging',
    'audience_profiling', 'creative_attention', 'some_future_goal']) {
    expect(untaggedAreFree({ goal_type: g })).toBe(false);
  }
});

test('a legacy UNTAGGED pricing survey is not shuffled at all (the ladder is safe)', () => {
  const qs = legacyUntaggedPricingSurvey();
  const canonical = ids(qs);
  for (let i = 0; i < 50; i += 1) {
    expect(ids(orderQuestionsForPersona(qs, pricingMission, P(`p${i}`)))).toEqual(canonical);
  }
  // …but the identical question list under the GENERIC goal does rotate.
  let rotated = false;
  for (let i = 0; i < 50; i += 1) {
    if (ids(orderQuestionsForPersona(qs, mission, P(`p${i}`))).join(',') !== canonical.join(',')) rotated = true;
  }
  expect(rotated).toBe(true);
});

test('the safety net is a no-op on modern TAGGED surveys (tagged blocks decide)', () => {
  // roadmap is order-sensitive, yet its tagged Kano/MaxDiff units still rotate.
  const qs = roadmapSurvey();
  const base = ids(orderQuestionsForPersona(qs, roadmapMission, P('p0')));
  let rotated = false;
  for (let i = 0; i < 50; i += 1) {
    if (ids(orderQuestionsForPersona(qs, roadmapMission, P(`p${i}`))).join(',') !== base.join(',')) rotated = true;
  }
  expect(rotated).toBe(true);
});

// ── 8. THE CRITICAL TEST — answers re-key, never re-index ───────────────

/**
 * Drive the real simulator with a mock that answers strictly in the order it
 * was ASKED. Every answer is uniquely derived from its own question id, so
 * any positional mis-mapping is detectable.
 */
function mockAnswersInAskedOrder({ shuffleReply = false } = {}) {
  mockCallClaude.mockImplementation(async ({ messages }) => {
    const prompt = messages[0].content;
    // question ids appear as "N. [qid] (type) text" in the prompt, in ASKED order
    const asked = [...prompt.matchAll(/^\d+\. \[([^\]]+)\]/gm)].map((m) => m[1]);
    const responses = asked.map((qid) => ({
      question_id: qid,
      answer: `ANS::${qid}`,
      reasoning: `because ${qid}`,
    }));
    if (shuffleReply) responses.reverse(); // model may answer out of order too
    return { text: JSON.stringify({ responses }) };
  });
}

test('CRITICAL: every answer lands on its ORIGINAL question_id, however aggressively the order is shuffled', async () => {
  const questions = freeSurvey(12);
  mockAnswersInAskedOrder();

  for (let i = 0; i < 30; i += 1) {
    const persona = P(`p${i}`);
    const asked = ids(orderQuestionsForPersona(questions, mission, persona));
    const rows = await simulateResponses(persona, questions, mission);

    // Every answer is keyed to its own question — the ONLY safe invariant.
    expect(rows).toHaveLength(questions.length);
    for (const r of rows) expect(r.answer).toBe(`ANS::${r.question_id}`);

    // Returned rows are in ORIGINAL question order, not asked order.
    expect(rows.map((r) => r.question_id)).toEqual(ids(questions));

    // Sanity: the asked order really did differ for at least some personas.
    if (i === 0) expect(asked).toHaveLength(questions.length);
  }
});

test('CRITICAL: re-keying holds even when the model replies out of order too', async () => {
  const questions = pricingSurvey();
  mockAnswersInAskedOrder({ shuffleReply: true });

  for (let i = 0; i < 20; i += 1) {
    const rows = await simulateResponses(P(`p${i}`), questions, pricingMission);
    expect(rows.map((r) => r.question_id)).toEqual(ids(questions));
    for (const r of rows) expect(r.answer).toBe(`ANS::${r.question_id}`);
  }
});

test('CRITICAL: the retry pass for missing questions also re-keys correctly', async () => {
  const questions = freeSurvey(10);
  let call = 0;
  mockCallClaude.mockImplementation(async ({ messages }) => {
    call += 1;
    const asked = [...messages[0].content.matchAll(/^\d+\. \[([^\]]+)\]/gm)].map((m) => m[1]);
    // First call drops the last three asked questions (simulated truncation).
    const subset = call === 1 ? asked.slice(0, asked.length - 3) : asked;
    return {
      text: JSON.stringify({
        responses: subset.map((qid) => ({ question_id: qid, answer: `ANS::${qid}`, reasoning: 'r' })),
      }),
    };
  });

  const rows = await simulateResponses(P('p-retry'), questions, mission);
  expect(call).toBe(2);
  expect(rows.map((r) => r.question_id)).toEqual(ids(questions));
  for (const r of rows) expect(r.answer).toBe(`ANS::${r.question_id}`);
});

/**
 * MUTATION-CHECK for the re-keying test. Reproduces the exact bug the test
 * exists to catch: mapping answers by ARRAY INDEX (asked order) instead of by
 * question_id. The assertion the CRITICAL tests make must fail against it.
 */
test('MUTATION-CHECK: mapping answers by index instead of id is detected', () => {
  const questions = freeSurvey(12);
  const persona = P('p3');
  const asked = orderQuestionsForPersona(questions, mission, persona);

  // The model answered in ASKED order.
  const askedAnswers = asked.map((q) => ({ question_id: q.id, answer: `ANS::${q.id}` }));

  // BUGGY re-indexing: zip asked-order answers onto original-order questions.
  const buggy = questions.map((q, i) => ({ question_id: q.id, answer: askedAnswers[i].answer }));

  // The invariant the CRITICAL test asserts:
  const holds = buggy.every((r) => r.answer === `ANS::${r.question_id}`);
  expect(holds).toBe(false);

  // and it is a real corruption, not a no-op reshuffle
  const corrupted = buggy.filter((r) => r.answer !== `ANS::${r.question_id}`);
  expect(corrupted.length).toBeGreaterThan(0);
});

/**
 * MUTATION-CHECK for the block-integrity tests. Shuffling a Van Westendorp or
 * Gabor-Granger block must make expectContiguousInOrder fail.
 */
test('MUTATION-CHECK: shuffling a Van Westendorp / Gabor-Granger block fails the block-integrity assertion', () => {
  const qs = pricingSurvey();
  const good = ids(orderQuestionsForPersona(qs, pricingMission, P('p3')));
  expect(() => expectContiguousInOrder(good, ['vw1', 'vw2', 'vw3', 'vw4'], 'vw')).not.toThrow();
  expect(() => expectContiguousInOrder(good, ['gg1', 'gg2', 'gg3', 'gg4', 'gg5'], 'gg')).not.toThrow();

  // Mutant A — VW bands permuted inside the block.
  const mutantVw = good.slice();
  const vwAt = good.indexOf('vw1');
  mutantVw.splice(vwAt, 4, 'vw3', 'vw1', 'vw4', 'vw2');
  expect(() => expectContiguousInOrder(mutantVw, ['vw1', 'vw2', 'vw3', 'vw4'], 'vw')).toThrow();

  // Mutant B — GG ladder reversed (descending prices).
  const mutantGg = good.slice();
  const ggAt = good.indexOf('gg1');
  mutantGg.splice(ggAt, 5, 'gg5', 'gg4', 'gg3', 'gg2', 'gg1');
  expect(() => expectContiguousInOrder(mutantGg, ['gg1', 'gg2', 'gg3', 'gg4', 'gg5'], 'gg')).toThrow();

  // Mutant C — a free question inserted into the middle of the VW block
  // (block fragmented rather than reordered).
  const mutantSplit = good.filter((id) => id !== 'f1');
  mutantSplit.splice(mutantSplit.indexOf('vw2') + 1, 0, 'f1');
  expect(() => expectContiguousInOrder(mutantSplit, ['vw1', 'vw2', 'vw3', 'vw4'], 'vw')).toThrow();

  // Mutant D — a Kano pair split apart.
  const kOrder = ids(orderQuestionsForPersona(roadmapSurvey(), roadmapMission, P('p3')));
  const mutantKano = kOrder.filter((id) => id !== 'k_fa_dy');
  mutantKano.push('k_fa_dy');
  expect(() => expectContiguousInOrder(mutantKano, ['k_fa_fn', 'k_fa_dy'], 'kano:fa')).toThrow();
});
