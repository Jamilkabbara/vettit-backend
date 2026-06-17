/* WO §3.2/§3.3 — generation-contract guards. The live generators need a valid
 * Anthropic key, so these unit-test the validators + builders that enforce the
 * exact question-metadata shape the analysis modules consume. */
const {
  validateAudienceProfilingSurvey,
  validateMarketEntrySurvey,
  buildAudienceProfilingUserPrompt,
  buildMarketEntryUserPrompt,
} = require('../src/services/claudeAI');
const { ATTITUDE_DIMENSIONS } = require('../src/services/analysis/audienceProfiling');

function goodAP() {
  return {
    productName: 'Oat milk',
    questions: [
      { id: 'q1', kind: 'screener', type: 'single', isScreening: true, options: ['Yes', 'No'], text: 'Buy oat milk?' },
      ...ATTITUDE_DIMENSIONS.map((d, i) => ({ id: `q${i + 2}`, kind: 'attitudinal', dimension: d, type: 'rating', options: [], text: `Attitude ${d}` })),
      { id: 'q8', kind: 'behavioural', type: 'single', options: ['Daily', 'Weekly'], text: 'How often?' },
      { id: 'q9', kind: 'behavioural', type: 'single', options: ['<$10', '$10+'], text: 'Spend?' },
      { id: 'q10', kind: 'behavioural', type: 'multi', options: ['A', 'B'], text: 'Which brands?' },
      { id: 'q11', kind: 'media', type: 'multi', options: ['MBC', 'Instagram'], text: 'Media?' },
      { id: 'q12', kind: 'needs', type: 'multi', options: ['Price', 'Taste'], text: 'Needs?' },
    ],
  };
}

function goodME() {
  return {
    productName: 'Delivery app',
    questions: [
      { id: 'q1', kind: 'screener', type: 'single', isScreening: true, options: ['Yes', 'No'], text: 'Order delivery in KSA?' },
      { id: 'q2', kind: 'appeal', type: 'rating', options: [], text: 'How appealing?' },
      { id: 'q3', kind: 'intent', type: 'single', options: ['Definitely would buy', 'Probably would buy', 'Might or might not', 'Probably would NOT buy', 'Definitely would NOT buy'], text: 'Would you use it?' },
      { id: 'q4', kind: 'wtp', type: 'single', options: ['SAR 5', 'SAR 10', 'SAR 15', 'SAR 20'], text: 'Fee?' },
      { id: 'q5', kind: 'barrier', type: 'multi', options: ['Regulatory', 'Cultural', 'Logistics', 'Competition', 'Awareness'], text: 'Hesitate?' },
      { id: 'q6', kind: 'competitive', type: 'multi', options: ['HungerStation', 'Jahez'], text: 'Use locally?' },
      { id: 'q7', kind: 'localisation', type: 'text', text: 'What to change?' },
    ],
  };
}

describe('audience_profiling generation contract', () => {
  test('accepts a well-formed 12-question battery', () => {
    expect(validateAudienceProfilingSurvey(goodAP())).toBeNull();
  });
  test('rejects a missing attitudinal dimension', () => {
    const s = goodAP();
    s.questions = s.questions.filter((q) => q.dimension !== 'sustainability');
    expect(validateAudienceProfilingSurvey(s)).toMatch(/sustainability/);
  });
  test('rejects when media / needs are absent', () => {
    const s = goodAP();
    s.questions = s.questions.filter((q) => q.kind !== 'media');
    expect(validateAudienceProfilingSurvey(s)).toMatch(/media/);
  });
  test('builder forwards segmentation focus + markets', () => {
    const p = buildAudienceProfilingUserPrompt({ description: 'oat milk', clarify: { segmentation_focus: 'health vs price', markets: 'UAE' } });
    expect(p).toMatch(/health vs price/);
    expect(p).toMatch(/UAE/);
  });
});

describe('market_entry generation contract', () => {
  test('accepts a well-formed battery', () => {
    expect(validateMarketEntrySurvey(goodME())).toBeNull();
  });
  test('rejects a missing required kind (barrier)', () => {
    const s = goodME();
    s.questions = s.questions.filter((q) => q.kind !== 'barrier');
    expect(validateMarketEntrySurvey(s)).toMatch(/barrier/);
  });
  test('rejects intent without 5 options', () => {
    const s = goodME();
    s.questions.find((q) => q.kind === 'intent').options = ['Yes', 'No'];
    expect(validateMarketEntrySurvey(s)).toMatch(/intent/);
  });
  test('builder forwards concept + target markets', () => {
    const p = buildMarketEntryUserPrompt({ description: 'app', clarify: { concept_description: 'food delivery', target_markets: 'Saudi Arabia', current_market: 'UAE' } });
    expect(p).toMatch(/food delivery/);
    expect(p).toMatch(/Saudi Arabia/);
  });
});
