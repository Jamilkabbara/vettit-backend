/**
 * A concern battery that cannot be declined measures the question.
 *
 * Anchored on a real delivered instrument. Mission 3fc15087 asked:
 *
 *   "What factors would make you hesitate before buying Premium Plant-Based
 *    Ready-Meals in Saudi Arabia or Egypt? Select all that apply."
 *
 * Nine concerns, no "none of these", no cap on selections, and the first
 * option merged two separate worries. Respondents ticked 4.6 of 9 options
 * each, and the top option came back at 98% (78 of 80) - a number that could
 * not have come back low, whatever the market thought.
 */

const {
  findViolations, normalizeQuestions, optionsForRespondent, doubleBarrelledOptions,
  hasEscapeOption, isCountingBattery, isOrderedList, DEFAULT_ESCAPE,
} = require('../src/services/ai/multiSelectHygiene');

/** The question as it actually shipped. */
const SHIPPED_Q5 = {
  id: 'q5',
  type: 'multi',
  text: 'What factors would make you hesitate before buying Premium Plant-Based Ready-Meals in Saudi Arabia or Egypt? Select all that apply.',
  options: [
    'Uncertainty about halal certification or religious compliance',
    'Lack of trust in plant-based ingredients or unfamiliar food technology',
    'Cultural preference for home-cooked or traditionally prepared meals',
    'Limited availability in local supermarkets or online delivery platforms',
    'Shorter shelf life of chilled products compared to frozen alternatives',
    'Strong existing local competition offering similar or cheaper options',
    'Low awareness of the brand - I have never heard of it before',
    'Price is too high relative to local income levels',
    'Concerns about nutritional adequacy compared to meat-based meals',
  ],
};

const AWARENESS_Q = {
  id: 'q6',
  type: 'multi',
  methodology: 'aided_brand_awareness',
  text: 'Which of the following brands have you heard of?',
  options: ['Brand A', 'Brand B', 'Brand C', 'Brand D', 'Brand E'],
};

const PRICE_BANDS = {
  id: 'q4',
  type: 'multi',
  text: 'Which price bands would you consider?',
  options: ['SAR 15-20 per meal', 'SAR 21-28 per meal', 'SAR 29-38 per meal', 'SAR 39-50 per meal'],
};

const LIKERT = {
  id: 'q9',
  type: 'multi',
  text: 'Which statements describe you?',
  options: ['Strongly agree', 'Somewhat agree', 'Neutral', 'Somewhat disagree', 'Strongly disagree'],
};

describe('the shipped question', () => {
  test('the two decidable faults are caught', () => {
    const rules = findViolations([SHIPPED_Q5]).map((x) => x.rule);
    expect(rules).toContain('missing_escape_option');
    expect(rules).toContain('uncapped_selections');
  });

  test('a merged option is advisory, never a rule: the text cannot decide it', () => {
    // The one that really is two concerns.
    expect(doubleBarrelledOptions(SHIPPED_Q5)).toContain('Uncertainty about halal certification or religious compliance');
    // ... but the same rule also flags options that are a single idea, which is
    // exactly why it does not gate anything.
    expect(doubleBarrelledOptions(SHIPPED_Q5)).toContain('Limited availability in local supermarkets or online delivery platforms');
    expect(findViolations([SHIPPED_Q5]).map((v) => v.rule)).not.toContain('double_barrelled_option');
  });

  test('normalising adds the escape option and the cap, and never splits an option', () => {
    const { questions, changes } = normalizeQuestions([SHIPPED_Q5]);
    const q = questions[0];
    expect(hasEscapeOption(q)).toBe(true);
    expect(q.options[q.options.length - 1]).toBe(DEFAULT_ESCAPE);
    expect(q.maxSelections).toBe(3);
    expect(q.options).toHaveLength(SHIPPED_Q5.options.length + 1);   // nothing split
    expect(changes.map((c) => c.change)).toEqual(['added_escape_option', 'capped_selections']);
    // Nothing decidable is left, and the merged option is passed to a human.
    expect(findViolations(questions)).toEqual([]);
    expect(normalizeQuestions([SHIPPED_Q5]).advisories.length).toBeGreaterThan(0);
  });
});

describe('what must not be capped', () => {
  test('an awareness battery gets an escape option but keeps every selection', () => {
    expect(isCountingBattery(AWARENESS_Q)).toBe(true);
    const { questions } = normalizeQuestions([AWARENESS_Q]);
    expect(hasEscapeOption(questions[0])).toBe(true);
    expect(questions[0].maxSelections).toBeUndefined();
  });

  test('an author\'s own cap is left alone', () => {
    const { questions } = normalizeQuestions([{ ...SHIPPED_Q5, maxSelections: 5 }]);
    expect(questions[0].maxSelections).toBe(5);
  });
});

describe('option order rotates per respondent', () => {
  test('different respondents see different first options, and every option is present', () => {
    const { questions } = normalizeQuestions([SHIPPED_Q5]);
    const q = questions[0];
    const firsts = new Set();
    for (const pid of ['P001', 'P002', 'P003', 'P004', 'P005', 'P006', 'P007', 'P008']) {
      const shown = optionsForRespondent(q, pid);
      expect(new Set(shown)).toEqual(new Set(q.options));      // same options
      expect(shown[shown.length - 1]).toBe(DEFAULT_ESCAPE);    // escape stays last
      firsts.add(shown[0]);
    }
    expect(firsts.size).toBeGreaterThan(1);
    expect(firsts.has('Uncertainty about halal certification or religious compliance')).toBe(true);
  });

  test('the same respondent always sees the same order', () => {
    expect(optionsForRespondent(SHIPPED_Q5, 'P007')).toEqual(optionsForRespondent(SHIPPED_Q5, 'P007'));
  });

  test('scales and price bands keep their order: a rotated scale is a broken scale', () => {
    expect(isOrderedList(LIKERT)).toBe(true);
    expect(isOrderedList(PRICE_BANDS)).toBe(true);
    for (const pid of ['P001', 'P002', 'P003']) {
      expect(optionsForRespondent(LIKERT, pid)).toEqual(LIKERT.options);
      expect(optionsForRespondent(PRICE_BANDS, pid)).toEqual(PRICE_BANDS.options);
    }
  });

  test('single-choice questions are never rotated', () => {
    const single = { id: 'q3', type: 'single', options: ['Yes', 'No', 'Maybe'] };
    expect(optionsForRespondent(single, 'P001')).toEqual(single.options);
  });
});

describe('a clean question is left exactly as written', () => {
  test('no changes, no violations', () => {
    const clean = {
      id: 'q7', type: 'multi', maxSelections: 3,
      text: 'Which, if any, of these would make you hesitate?',
      options: ['Price', 'Availability', 'Taste', DEFAULT_ESCAPE],
    };
    const { questions, changes, remaining } = normalizeQuestions([clean]);
    expect(changes).toEqual([]);
    expect(remaining).toEqual([]);
    expect(questions[0]).toEqual(clean);
  });
});
