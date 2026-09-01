/**
 * A user-drafted (untagged) question must be INERT to the methodology
 * analyses: no crash, no null, and — the part that actually matters —
 * no mis-bucketing.
 *
 * Every module in services/analysis/* selects questions by a POSITIVE
 * tag predicate:
 *
 *   audienceProfiling.js:153  qs.find(q => q.kind==='attitudinal' && q.dimension===d)
 *   pricing.js:117            q.methodology==='van_westendorp' && VW_BANDS.includes(q.vw_band)
 *   roadmap.js:169/228        q.methodology==='max_diff' / 'kano' + feature_id + kano_type
 *   churn.js:151              qs.filter(q => q.churn_stage===s)
 *   marketing.js:126          skips anything without a string funnel_stage
 *   competitor.js:185/220     q.funnel_stage==='awareness' / 'attributes'
 *   compare.js:160            requires a truthy q.concept_id to enter a battery
 *   brandLift.js:104          is_lift_question, else a non-screening funnel_stage
 *   naming.js:191/255         q.candidate_id / q.is_paired_comparison===true
 *   marketEntry.js:77         qs.filter(q => q.kind===kind)
 *
 * so an object carrying none of those keys fails all of them. This
 * test proves that claim against the REAL computeAnalysis rather than
 * restating it.
 *
 * ── Why it is a DIFFERENTIAL test ───────────────────────────────────
 * "Appending the clean draft changes nothing" is only meaningful if
 * appending SOMETHING could change something. So each goal type is run
 * three ways against identical response rows:
 *
 *   baseline    — the tagged battery alone
 *   withClean   — plus the real endpoint output (untagged)
 *   withTagged  — plus the SAME question wearing every methodology tag
 *
 * withClean must equal baseline. withTagged must differ from baseline
 * for a meaningful number of methodologies — that is the control arm,
 * and it is asserted, so this file cannot silently degrade into a test
 * that would pass no matter what the endpoint emits.
 */

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { computeAnalysis } = require('../src/services/analysis');
const { buildDraftQuestion, USER_DRAFTED_SOURCE } = require('../src/services/ai/draftQuestion');

const GOAL_TYPES = [
  'brand_lift', 'marketing', 'pricing', 'roadmap', 'satisfaction',
  'churn_research', 'validate', 'naming_messaging', 'compare',
  'competitor', 'audience_profiling', 'market_entry',
];

// ── A battery carrying the tags of every methodology at once, so each
//    dispatcher finds real work to do and produces populated blocks.
const QUESTIONS = [
  { id: 'q1', text: 'Do you drink coffee at home?', type: 'single', options: ['Yes', 'No'], kind: 'screener', funnel_stage: 'screening', is_lift_question: false },
  { id: 'q2', text: 'Which brands have you seen advertised?', type: 'multi', options: ['Acme', 'Bolt', 'None of these'], kind: 'awareness', funnel_stage: 'awareness', kpi_category: 'awareness', is_lift_question: true },
  { id: 'q3', text: 'Which brands would you consider?', type: 'multi', options: ['Acme', 'Bolt'], funnel_stage: 'consideration', kpi_category: 'consideration', is_lift_question: true },
  { id: 'q4', text: 'Which brand do you prefer?', type: 'single', options: ['Acme', 'Bolt'], funnel_stage: 'preference', is_lift_question: true },
  { id: 'q5', text: 'Which do you currently use?', type: 'single', options: ['Acme', 'Bolt'], funnel_stage: 'use' },
  { id: 'q6', text: 'How likely are you to recommend Acme?', type: 'rating', options: [], funnel_stage: 'recommendation', kind: 'nps' },
  { id: 'q7', text: 'Which attributes fit Acme?', type: 'multi', options: ['Premium', 'Reliable', 'Affordable'], funnel_stage: 'attributes', brand_id: 'our_brand' },
  { id: 'q8', text: 'At what price is it so cheap you would doubt quality?', type: 'text', methodology: 'van_westendorp', vw_band: 'too_cheap', currency: 'USD' },
  { id: 'q9', text: 'At what price is it a bargain?', type: 'text', methodology: 'van_westendorp', vw_band: 'bargain' },
  { id: 'q10', text: 'At what price is it getting expensive?', type: 'text', methodology: 'van_westendorp', vw_band: 'expensive' },
  { id: 'q11', text: 'At what price is it too expensive?', type: 'text', methodology: 'van_westendorp', vw_band: 'too_expensive' },
  { id: 'q12', text: 'Would you buy at $10?', type: 'single', options: ['Definitely would buy', 'Probably would buy', 'Might buy', 'Probably would not buy', 'Definitely would not buy'], methodology: 'gabor_granger', gg_anchor_index: 0 },
  { id: 'q13', text: 'Would you buy at $15?', type: 'single', options: ['Definitely would buy', 'Probably would buy', 'Might buy', 'Probably would not buy', 'Definitely would not buy'], methodology: 'gabor_granger', gg_anchor_index: 1 },
  { id: 'q14', text: 'Best and worst of these features?', type: 'single', options: ['Faster delivery', 'Lower price', 'More variety'], methodology: 'max_diff', feature_set: ['f1', 'f2', 'f3'] },
  { id: 'q15', text: 'How would you feel if faster delivery existed?', type: 'single', options: ['I like it', 'I expect it', 'I am neutral', 'I can tolerate it', 'I dislike it'], methodology: 'kano', feature_id: 'f1', kano_type: 'functional' },
  { id: 'q16', text: 'How would you feel if faster delivery did not exist?', type: 'single', options: ['I like it', 'I expect it', 'I am neutral', 'I can tolerate it', 'I dislike it'], methodology: 'kano', feature_id: 'f1', kano_type: 'dysfunctional' },
  { id: 'q17', text: 'Why did you cancel?', type: 'multi', options: ['Too expensive', 'Not useful'], churn_stage: 'reason' },
  { id: 'q18', text: 'Would you come back?', type: 'single', options: ['Yes', 'Maybe', 'No'], churn_stage: 'win_back' },
  { id: 'q19', text: 'Did you switch to a competitor?', type: 'text', options: [], churn_stage: 'switch' },
  { id: 'q35', text: 'How satisfied were you at the time you left?', type: 'single', options: ['Very dissatisfied', 'Dissatisfied', 'Neutral', 'Satisfied', 'Very satisfied'], churn_stage: 'satisfaction' },
  { id: 'q36', text: 'What was the first sign you would leave?', type: 'text', options: [], churn_stage: 'warning' },
  { id: 'q37', text: 'How long were you a customer?', type: 'single', options: ['Less than 1 month', '1-3 months', '3-12 months'], churn_stage: 'tenure' },
  { id: 'q20', text: 'Considering Concept A: how appealing is it?', type: 'rating', options: [], concept_id: 'c1', funnel_stage: 'appeal' },
  { id: 'q21', text: 'Considering Concept A: how relevant is it?', type: 'rating', options: [], concept_id: 'c1', funnel_stage: 'relevance' },
  { id: 'q22', text: 'Which concept would you pick?', type: 'single', options: ['Concept A', 'Concept B'], is_final_choice: true },
  { id: 'q23', text: 'How memorable is [Lumio]?', type: 'rating', options: [], candidate_id: 'n1', criterion: 'memorability', methodology: 'monadic_plus_paired' },
  { id: 'q24', text: 'Lumio or Vantage?', type: 'single', options: ['Lumio', 'Vantage'], is_paired_comparison: true, methodology: 'paired_comparison' },
  { id: 'q25', text: 'Do you agree that price matters most?', type: 'rating', options: [], kind: 'attitudinal', dimension: 'price_sensitivity' },
  { id: 'q26', text: 'Do you agree that brand matters most?', type: 'rating', options: [], kind: 'attitudinal', dimension: 'brand_affinity' },
  { id: 'q27', text: 'How likely are you to buy?', type: 'single', options: ['Definitely would', 'Probably would', 'Might', 'Probably not', 'Definitely not'], kind: 'intent', funnel_stage: 'intent' },
  { id: 'q28', text: 'How appealing is this?', type: 'rating', options: [], kind: 'appeal' },
  { id: 'q29', text: 'What would stop you buying?', type: 'text', options: [], kind: 'barrier' },
  { id: 'q30', text: 'Whose ad was that?', type: 'text', options: [], funnel_stage: 'attribution' },
  { id: 'q31', text: 'Did you see this ad?', type: 'single', options: ['Yes', 'No'], funnel_stage: 'recall' },
  { id: 'q32', text: 'How much did it stand out?', type: 'rating', options: [], funnel_stage: 'stopping' },
  { id: 'q33', text: 'How satisfied are you overall?', type: 'rating', options: [], kind: 'csat' },
  { id: 'q34', text: 'How much effort did that take?', type: 'rating', options: [], kind: 'ces' },
];

// ── Deterministic answers so every block computes real numbers. ──
const TEXT_ANSWERS = { q8: '5', q9: '10', q10: '15', q11: '25', q19: 'Bolt', q29: 'Price', q30: 'Acme' };
const CHOICE = {
  q1: ['Yes', 'Yes', 'No'], q2: ['Acme', 'Bolt', 'Acme'], q3: ['Acme', 'Acme', 'Bolt'],
  q4: ['Acme', 'Bolt', 'Acme'], q5: ['Acme', 'Acme', 'Bolt'], q7: ['Premium', 'Reliable', 'Premium'],
  q12: ['Definitely would buy', 'Probably would buy', 'Might buy'],
  q13: ['Probably would buy', 'Might buy', 'Definitely would not buy'],
  q14: ['Faster delivery', 'Lower price', 'Faster delivery'],
  q15: ['I like it', 'I like it', 'I expect it'], q16: ['I dislike it', 'I dislike it', 'I am neutral'],
  q17: ['Too expensive', 'Not useful', 'Too expensive'], q18: ['Yes', 'No', 'Maybe'],
  q22: ['Concept A', 'Concept B', 'Concept A'], q24: ['Lumio', 'Vantage', 'Lumio'],
  q27: ['Definitely would', 'Probably would', 'Might'],
};
const PERSONAS = ['p1', 'p2', 'p3'];

function buildRows(questions) {
  const rows = [];
  questions.forEach((q) => {
    PERSONAS.forEach((pid, i) => {
      let answer;
      if (q.methodology === 'max_diff') {
        // roadmap.js parseMaxDiffAnswer wants {best, worst}; the offset
        // makes the control question's answers differ from q14's so the
        // utilities actually move when it is captured.
        const o = q.options;
        const off = q.id === 'qDraft' ? 1 : 0;
        answer = JSON.stringify({ best: o[(i + off) % o.length], worst: o[(i + 1 + off) % o.length] });
      } else if (TEXT_ANSWERS[q.id] !== undefined) answer = TEXT_ANSWERS[q.id];
      else if (CHOICE[q.id]) answer = CHOICE[q.id][i];
      else if (q.type === 'rating') answer = String(3 + (i % 3));
      else if (q.type === 'text') answer = `verbatim ${i}`;
      else if (Array.isArray(q.options) && q.options.length) answer = q.options[i % q.options.length];
      else answer = String(3 + (i % 3));
      rows.push({
        persona_id: pid,
        question_id: q.id,
        answer,
        exposure_status: i === 0 ? 'control' : 'exposed',
        persona_profile: { country: i === 0 ? 'SA' : 'EG', age: 30 + i, gender: 'female' },
      });
    });
  });
  return rows;
}

const MISSION_BASE = {
  id: 'mission-1',
  brand_name: 'Acme',
  competitor_brands: ['Bolt'],
  concepts: [{ id: 'c1', name: 'Concept A' }, { id: 'c2', name: 'Concept B' }],
  naming_candidates: [{ id: 'n1', name: 'Lumio' }, { id: 'n2', name: 'Vantage' }],
  roadmap_features: [{ id: 'f1', name: 'Faster delivery' }, { id: 'f2', name: 'Lower price' }, { id: 'f3', name: 'More variety' }],
  targeting: { countries: ['SA', 'EG'] },
};

// ── The draft, produced by the REAL builder so the test tracks the
//    endpoint rather than a hand-typed guess of its output. ──
const CLEAN_DRAFT = {
  ...buildDraftQuestion({ text: 'How often do you reorder coffee?', type: 'single', options: ['Weekly', 'Monthly', 'Rarely'] }),
  id: 'qDraft',
};

// ── The control arm ────────────────────────────────────────────────
// The SAME question, tagged for the methodology under test. Tags are
// chosen to land in a slot the battery leaves free, because most of
// these modules are "first match wins" — a tag that collides with an
// existing question loses to it and would understate how captureable
// a tagged question really is. Where a methodology keys off option
// content as well as a tag, the control carries matching options too.
const CONTROL_TAGS = {
  brand_lift:         { is_lift_question: true, funnel_stage: 'awareness', kpi_category: 'awareness', type: 'multi', options: ['Acme', 'Bolt'] },
  marketing:          { funnel_stage: 'likeability', type: 'rating', options: [] },
  pricing:            { text: 'Would you buy at $20?', methodology: 'gabor_granger', gg_anchor_index: 2, type: 'single', options: ['Definitely would buy', 'Probably would buy', 'Might buy', 'Probably would not buy', 'Definitely would not buy'] },
  roadmap:            { text: 'Best and worst of these features?', methodology: 'max_diff', feature_set: ['f1', 'f2', 'f3'], type: 'single', options: ['Faster delivery', 'Lower price', 'More variety'] },
  satisfaction:       { methodology: 'attribute_matrix', type: 'rating', options: [] },
  churn_research:     { text: 'How easy was it to cancel?', churn_stage: 'switch', type: 'rating', options: [] },
  validate:           { funnel_stage: 'price_fairness', type: 'rating', options: [] },
  naming_messaging:   { candidate_id: 'n2', criterion: 'memorability', methodology: 'monadic_plus_paired', type: 'rating', options: [] },
  compare:            { concept_id: 'c2', funnel_stage: 'appeal', type: 'rating', options: [] },
  competitor:         { text: 'Which attributes fit Bolt?', funnel_stage: 'attributes', type: 'multi', options: ['Premium', 'Reliable'] },
  audience_profiling: { kind: 'attitudinal', dimension: 'convenience', type: 'rating', options: [] },
  market_entry:       { kind: 'wtp', type: 'single', options: ['$10', '$15', '$20'] },
};

const taggedDraftFor = (goalType) => ({ ...CLEAN_DRAFT, ...CONTROL_TAGS[goalType] });

const DRAFT_ROWS = buildRows([CLEAN_DRAFT]);
const BASE_ROWS = buildRows(QUESTIONS);

/** Strip the wall-clock stamp so two runs are comparable. */
function stable(analysis) {
  if (!analysis) return analysis;
  const { computed_at, ...rest } = analysis;
  return rest;
}

const run = (goalType, questions, rows) =>
  computeAnalysis({ ...MISSION_BASE, goal_type: goalType, questions }, rows);

describe('untagged user-drafted questions are inert to the methodology analyses', () => {
  test('the fixture is real: the clean draft carries no tag and no id collision', () => {
    expect(CLEAN_DRAFT.source).toBe(USER_DRAFTED_SOURCE);
    expect(Object.keys(CLEAN_DRAFT).sort()).toEqual(['id', 'options', 'source', 'text', 'type']);
    expect(QUESTIONS.some((q) => q.id === CLEAN_DRAFT.id)).toBe(false);
  });

  test.each(GOAL_TYPES)('%s: appending the draft does not change a single number', (goalType) => {
    const baseline = run(goalType, QUESTIONS, BASE_ROWS);
    const withClean = run(goalType, [...QUESTIONS, CLEAN_DRAFT], [...BASE_ROWS, ...DRAFT_ROWS]);
    expect(stable(withClean)).toEqual(stable(baseline));
  });

  test.each(GOAL_TYPES)('%s: neither run crashes or returns null', (goalType) => {
    const baseline = run(goalType, QUESTIONS, BASE_ROWS);
    const withClean = run(goalType, [...QUESTIONS, CLEAN_DRAFT], [...BASE_ROWS, ...DRAFT_ROWS]);
    expect(baseline).not.toBeNull();
    expect(withClean).not.toBeNull();
    expect(withClean.methodology).toBe(baseline.methodology);
    expect(JSON.stringify(withClean)).not.toMatch(/NaN|undefined/);
  });

  test.each(GOAL_TYPES)('%s: the draft is never named anywhere in the output', (goalType) => {
    const withClean = run(goalType, [...QUESTIONS, CLEAN_DRAFT], [...BASE_ROWS, ...DRAFT_ROWS]);
    expect(JSON.stringify(withClean)).not.toContain('qDraft');
    expect(JSON.stringify(withClean)).not.toContain('reorder coffee');
  });

  test('the draft still survives as a plain distribution under goal_type=research', () => {
    // Untagged does NOT mean invisible. The generic block enumerates
    // every question, so the user does get their answers back — as a
    // raw distribution, with no methodology role attached.
    const research = run('research', [...QUESTIONS, CLEAN_DRAFT], [...BASE_ROWS, ...DRAFT_ROWS]);
    const entry = research.per_question.find((p) => p.question_id === 'qDraft');
    expect(entry).toBeDefined();
    expect(entry.n).toBe(PERSONAS.length);
    expect(entry.text).toBe('How often do you reorder coffee?');
  });

  // ── CONTROL ARM ────────────────────────────────────────────────────
  // If a tagged question were appended instead, the analyses WOULD move.
  // Without this, the invariance assertions above could pass on a build
  // where the analyses ignore appended questions entirely.
  test.each(GOAL_TYPES)(
    'CONTROL — %s: the SAME question WITH that methodology\'s tags IS captured',
    (goalType) => {
      const baseline = run(goalType, QUESTIONS, BASE_ROWS);
      const tagged = taggedDraftFor(goalType);
      const withTagged = run(goalType, [...QUESTIONS, tagged], [...BASE_ROWS, ...buildRows([tagged])]);
      // If this ever stops differing, the invariance assertions above
      // have gone vacuous for this methodology and must be re-derived.
      expect(stable(withTagged)).not.toEqual(stable(baseline));
    },
  );
});
