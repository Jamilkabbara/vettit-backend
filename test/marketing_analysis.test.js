/**
 * Pass 46 Phase 3 — marketing (ad_effectiveness) deterministic analysis,
 * hand-computed fixtures. The LLM never computes these numbers.
 *
 * Battery fixture math:
 *  - aided recall (q4 single Yes/No/Not sure): 3 Yes of 5 → 0.6
 *  - attribution (q5 text, brand 'Acme Cola'): 2 of 4 contain the brand → 0.5
 *  - likeability [5,6,7,6]: mean 6, s = √(2/3) ≈ 0.8165
 *  - stopping  [4,4,4,4]: mean 4, s = 0
 *  - distinctiveness [3,5]: mean 4, s = √2 ≈ 1.4142
 *  - emotional: {Amused:2, Curious:1, Bored:1} over n=3 respondents
 *  - persuasion [6,7,5,6]: mean 6
 *  - message_match Yes/Somewhat/No/Yes → 0.5
 *  - sharing Yes/Maybe/No/Yes/Yes → 0.6
 *  - unaided recall: 35 verbatims → capped at 30
 */

const { computeMarketing } = require('../src/services/analysis/marketing');

const mk = (persona, qid, answer) => ({
  persona_id: persona,
  question_id: qid,
  answer,
  exposure_status: 'not_applicable',
  persona_profile: {},
});

// Fixed 12/13-question battery per MARKETING_SURVEY_GEN_SYSTEM stage order.
const QUESTIONS = [
  { id: 'q1', text: 'Do you buy soda?', type: 'single', options: ['Yes, regularly', 'No'], isScreening: true, methodology: 'ad_effectiveness', funnel_stage: 'screener' },
  { id: 'q2', text: 'What ads have you seen recently for soda?', type: 'text', options: [], methodology: 'ad_effectiveness', funnel_stage: 'recall' },
  { id: 'q3', text: '[https://cdn/ad.png] Please review the ad above before answering.', type: 'text', options: [], methodology: 'ad_effectiveness', funnel_stage: 'exposure' },
  { id: 'q4', text: 'Have you seen this ad before?', type: 'single', options: ['Yes', 'No', 'Not sure'], methodology: 'ad_effectiveness', funnel_stage: 'recall' },
  { id: 'q5', text: 'Whose ad is this?', type: 'text', options: [], methodology: 'ad_effectiveness', funnel_stage: 'attribution' },
  { id: 'q6', text: "What's the main message of this ad?", type: 'text', options: [], methodology: 'ad_effectiveness', funnel_stage: 'message' },
  { id: 'q7', text: 'How much did you like this ad?', type: 'rating', options: [], methodology: 'ad_effectiveness', funnel_stage: 'likeability' },
  { id: 'q8', text: 'Would this ad get your attention?', type: 'rating', options: [], methodology: 'ad_effectiveness', funnel_stage: 'stopping' },
  { id: 'q9', text: 'How different is this from other soda ads?', type: 'rating', options: [], methodology: 'ad_effectiveness', funnel_stage: 'distinctiveness' },
  { id: 'q10', text: 'How does this ad make you feel?', type: 'multi', options: ['Amused', 'Inspired', 'Curious', 'Bored'], methodology: 'ad_effectiveness', funnel_stage: 'emotional' },
  { id: 'q11', text: 'Are you more or less likely to consider Acme Cola?', type: 'rating', options: [], methodology: 'ad_effectiveness', funnel_stage: 'persuasion' },
  { id: 'q12', text: 'Did the ad communicate refreshment?', type: 'single', options: ['Yes', 'Somewhat', 'No'], methodology: 'ad_effectiveness', funnel_stage: 'message_match' },
  { id: 'q13', text: 'Would you share or recommend this ad to a friend?', type: 'single', options: ['Yes', 'Maybe', 'No'], methodology: 'ad_effectiveness', funnel_stage: 'sharing' },
];

const MISSION = { brand_name: 'Acme Cola' };

function buildRows() {
  const rows = [];
  // q1 screener — never emitted in the funnel block
  ['p1', 'p2', 'p3', 'p4', 'p5'].forEach((p) => rows.push(mk(p, 'q1', 'Yes, regularly')));
  // q2 unaided recall — 35 verbatims to prove the 30 cap
  for (let i = 1; i <= 35; i += 1) rows.push(mk(`u${i}`, 'q2', `Ad number ${i}`));
  // q3 exposure acknowledgement — no metric anywhere
  rows.push(mk('p1', 'q3', 'Okay, reviewed.'));
  // q4 aided recall — 3/5 Yes
  rows.push(mk('p1', 'q4', 'Yes'));
  rows.push(mk('p2', 'q4', 'Yes'));
  rows.push(mk('p3', 'q4', 'Yes'));
  rows.push(mk('p4', 'q4', 'No'));
  rows.push(mk('p5', 'q4', 'Not sure'));
  // q5 attribution — 2/4 contain 'Acme Cola' (case-insensitive substring)
  rows.push(mk('p1', 'q5', 'Acme Cola'));
  rows.push(mk('p2', 'q5', 'I think it is ACME cola'));
  rows.push(mk('p3', 'q5', 'Pepsi'));
  rows.push(mk('p4', 'q5', 'no idea'));
  // q6 main message verbatims
  rows.push(mk('p1', 'q6', 'Refreshing taste'));
  rows.push(mk('p2', 'q6', 'It is cheap'));
  // q7 likeability [5,6,7,6]
  [5, 6, 7, 6].forEach((v, i) => rows.push(mk(`p${i + 1}`, 'q7', v)));
  // q8 stopping [4,4,4,4]
  [4, 4, 4, 4].forEach((v, i) => rows.push(mk(`p${i + 1}`, 'q8', v)));
  // q9 distinctiveness [3,5]
  [3, 5].forEach((v, i) => rows.push(mk(`p${i + 1}`, 'q9', v)));
  // q10 emotional multi
  rows.push(mk('p1', 'q10', ['Amused', 'Curious']));
  rows.push(mk('p2', 'q10', ['Bored']));
  rows.push(mk('p3', 'q10', ['Amused']));
  // q11 persuasion [6,7,5,6]
  [6, 7, 5, 6].forEach((v, i) => rows.push(mk(`p${i + 1}`, 'q11', v)));
  // q12 message match — 2/4 Yes
  ['Yes', 'Somewhat', 'No', 'Yes'].forEach((v, i) => rows.push(mk(`p${i + 1}`, 'q12', v)));
  // q13 sharing — 3/5 Yes
  ['Yes', 'Maybe', 'No', 'Yes', 'Yes'].forEach((v, i) => rows.push(mk(`p${i + 1}`, 'q13', v)));
  return rows;
}

describe('computeMarketing battery fixture', () => {
  const out = computeMarketing(buildRows(), QUESTIONS, MISSION);

  test('methodology + norms placeholder (no benchmark DB yet)', () => {
    expect(out.methodology).toBe('marketing');
    expect(out.norms).toBeNull();
  });

  test('recall_aided: 3/5 Yes → 0.6 with base n', () => {
    expect(out.funnel.recall_aided).toEqual({ n: 5, positive_rate: 0.6 });
  });

  test('attribution: 2/4 answers contain the brand → 0.5', () => {
    expect(out.funnel.attribution).toEqual({ n: 4, correct_rate: 0.5 });
  });

  test('likeability [5,6,7,6]: mean 6, sd √(2/3), 95% CI ±1.96·sd/√4', () => {
    const s = out.funnel.likeability;
    expect(s.n).toBe(4);
    expect(s.mean).toBeCloseTo(6, 4);
    expect(s.stddev).toBeCloseTo(0.8165, 3);
    expect(s.ci_low).toBeCloseTo(6 - 1.96 * (0.816497 / 2), 3);
    expect(s.ci_high).toBeCloseTo(6 + 1.96 * (0.816497 / 2), 3);
  });

  test('stopping_power (funnel_stage "stopping") [4,4,4,4]: mean 4, sd 0', () => {
    const s = out.funnel.stopping_power;
    expect(s.n).toBe(4);
    expect(s.mean).toBeCloseTo(4, 4);
    expect(s.stddev).toBeCloseTo(0, 4);
  });

  test('distinctiveness [3,5]: mean 4, sd √2', () => {
    const s = out.funnel.distinctiveness;
    expect(s.n).toBe(2);
    expect(s.mean).toBeCloseTo(4, 4);
    expect(s.stddev).toBeCloseTo(1.4142, 3);
  });

  test('persuasion [6,7,5,6]: mean 6, n 4', () => {
    expect(out.funnel.persuasion.n).toBe(4);
    expect(out.funnel.persuasion.mean).toBeCloseTo(6, 4);
  });

  test('emotional: per-selection distribution over n=3 respondents', () => {
    expect(out.funnel.emotional).toEqual({
      n: 3,
      distribution: { Amused: 2, Curious: 1, Bored: 1 },
    });
  });

  test('message_match 2/4 Yes and sharing 3/5 Yes', () => {
    expect(out.funnel.message_match).toEqual({ n: 4, positive_rate: 0.5 });
    expect(out.funnel.sharing).toEqual({ n: 5, positive_rate: 0.6 });
  });

  test('openEnded: unaided recall capped at 30, message verbatims passed through', () => {
    expect(out.openEnded.recall_unaided_verbatims).toHaveLength(30);
    expect(out.openEnded.recall_unaided_verbatims[0]).toBe('Ad number 1');
    expect(out.openEnded.message_verbatims).toEqual(['Refreshing taste', 'It is cheap']);
  });

  test('output is JSON-serializable with no undefined/NaN/Infinity', () => {
    expect(JSON.parse(JSON.stringify(out))).toStrictEqual(out);
  });
});

// ── absent stages and degenerate inputs ─────────────────────────────────

test('missing stages → null (never invented)', () => {
  // Battery with ONLY a likeability question answered.
  const qs = [QUESTIONS[6]]; // q7 likeability
  const rows = [mk('p1', 'q7', 5), mk('p2', 'q7', 5)];
  const out = computeMarketing(rows, qs, MISSION);
  expect(out.funnel.likeability.mean).toBeCloseTo(5, 4);
  expect(out.funnel.likeability.n).toBe(2);
  expect(out.funnel.recall_aided).toBeNull();
  expect(out.funnel.attribution).toBeNull();
  expect(out.funnel.stopping_power).toBeNull();
  expect(out.funnel.distinctiveness).toBeNull();
  expect(out.funnel.persuasion).toBeNull();
  expect(out.funnel.emotional).toBeNull();
  expect(out.funnel.message_match).toBeNull();
  expect(out.funnel.sharing).toBeNull();
  expect(out.openEnded.recall_unaided_verbatims).toEqual([]);
  expect(out.openEnded.message_verbatims).toEqual([]);
});

test('attribution without mission.brand_name → null (no anchor to grade against)', () => {
  const rows = [mk('p1', 'q5', 'Acme Cola'), mk('p2', 'q5', 'Pepsi')];
  const out = computeMarketing(rows, QUESTIONS, {});
  expect(out.funnel.attribution).toBeNull();
});

test('empty rows → all-null funnel, empty verbatims, stable shape', () => {
  const out = computeMarketing([], QUESTIONS, MISSION);
  expect(out.methodology).toBe('marketing');
  for (const v of Object.values(out.funnel)) expect(v).toBeNull();
  expect(out.norms).toBeNull();
  expect(out.openEnded).toEqual({ recall_unaided_verbatims: [], message_verbatims: [] });
  expect(JSON.parse(JSON.stringify(out))).toStrictEqual(out);
});
