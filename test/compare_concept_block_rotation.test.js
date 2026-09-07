/**
 * Sequential-monadic concept BLOCKS rotate per respondent.
 *
 * WHY. Sequential monadic without concept rotation gives concept 1 a
 * systematic position advantage. Ranking concepts is the entire output of
 * this instrument, so the bias lands exactly on the number the customer
 * reads. claudeAI.js COMPARE_SURVEY_GEN_SYSTEM already told the model "the
 * simulator handles per-respondent rotation"; until Pass 51 it did not, and
 * missions.rotation_strategy='random' was written on every compare mission
 * and read by nothing.
 *
 * WHAT MUST NOT MOVE, and why each matters:
 *   - Each battery's INTERNAL order. analysis/compare.js infers a missing
 *     funnel_stage from the question's index within its concept battery, so
 *     reordering inside a battery could relabel appeal as relevance and
 *     produce a confidently wrong ranking with nothing looking broken.
 *   - The forced-choice tail (is_final_choice). Only answerable once every
 *     concept has been seen.
 *   - The screener, which is pinned first for every instrument.
 */
const { orderQuestionsForPersona } = require('../src/services/ai/questionOrder');

const STAGES = ['appeal', 'relevance', 'uniqueness', 'intent', 'qualitative'];

function compareSurvey(conceptIds) {
  const qs = [{ id: 'q1', isScreening: true, text: 'screener' }];
  for (const cid of conceptIds) {
    STAGES.forEach((st) => qs.push({ id: `${cid}_${st}`, concept_id: cid, funnel_stage: st }));
  }
  qs.push({ id: 'qFinal', is_final_choice: true });
  return qs;
}

const mission = { id: 'm1', goal_type: 'compare' };
const orderOf = (out) => {
  const seen = [];
  for (const q of out) if (q.concept_id && !seen.includes(q.concept_id)) seen.push(q.concept_id);
  return seen.join('>');
};

describe('concept blocks rotate across respondents', () => {
  test('three concepts produce more than one order over 40 personas', () => {
    const qs = compareSurvey(['c1', 'c2', 'c3']);
    const orders = new Set();
    for (let i = 0; i < 40; i++) orders.add(orderOf(orderQuestionsForPersona(qs, mission, { id: `p${i}` })));
    expect(orders.size).toBeGreaterThan(1);
  });

  test('the order is deterministic for a given persona', () => {
    // Same persona must always see the same survey: a re-run or a resumed
    // mission cannot silently re-randomise what was already answered.
    const qs = compareSurvey(['c1', 'c2', 'c3']);
    const a = orderOf(orderQuestionsForPersona(qs, mission, { id: 'stable' }));
    const b = orderOf(orderQuestionsForPersona(qs, mission, { id: 'stable' }));
    expect(a).toBe(b);
  });
});

describe('what must not move', () => {
  const qs = compareSurvey(['c1', 'c2', 'c3', 'c4']);
  const runs = Array.from({ length: 40 }, (_, i) => orderQuestionsForPersona(qs, mission, { id: `p${i}` }));

  test("each battery keeps its internal stage order, so compare.js's positional fallback stays valid", () => {
    for (const out of runs) {
      for (const cid of ['c1', 'c2', 'c3', 'c4']) {
        const stages = out.filter((q) => q.concept_id === cid).map((q) => q.funnel_stage);
        expect(stages).toEqual(STAGES);
      }
    }
  });

  test('the forced-choice question is always last', () => {
    for (const out of runs) expect(out[out.length - 1].id).toBe('qFinal');
  });

  test('the screener is always first', () => {
    for (const out of runs) expect(out[0].id).toBe('q1');
  });

  test('every question survives exactly once', () => {
    for (const out of runs) {
      expect(out).toHaveLength(qs.length);
      expect(new Set(out.map((q) => q.id)).size).toBe(qs.length);
    }
  });

  test('a battery is never interleaved with another battery', () => {
    // Contiguity is the whole point of block rotation: c1's five questions
    // must sit together, not be shuffled among c2's.
    for (const out of runs) {
      const concepts = out.filter((q) => q.concept_id).map((q) => q.concept_id);
      const runsOf = concepts.filter((c, i) => c !== concepts[i - 1]);
      expect(runsOf).toHaveLength(new Set(concepts).size);
    }
  });
});

describe('the forced-choice tail is not itself rotatable', () => {
  test('a survey of only a final-choice question is unchanged', () => {
    const qs = [{ id: 'q1', isScreening: true }, { id: 'qFinal', is_final_choice: true }];
    const out = orderQuestionsForPersona(qs, mission, { id: 'p1' });
    expect(out.map((q) => q.id)).toEqual(['q1', 'qFinal']);
  });
});
