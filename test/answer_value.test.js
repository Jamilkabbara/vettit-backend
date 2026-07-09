/**
 * WO#1 — not_applicable skip handling.
 * The simulator encodes a conditional-question skip as a null answer; the DB
 * column is JSONB NOT NULL, so the null must become the 'not_applicable'
 * sentinel at storage, and the analysis layer must treat that sentinel as a
 * SKIP (never a bar, a mean input, or a % denominator).
 */
const { NOT_APPLICABLE, normalizeAnswerForStorage, isSkip } = require('../src/utils/answerValue');
const { distribution, ratingStats } = require('../src/services/analysis/shared');
const { aggregate } = require('../src/services/ai/insights');

describe('normalizeAnswerForStorage — never SQL null', () => {
  test('null / undefined / empty become the sentinel string', () => {
    expect(normalizeAnswerForStorage(null)).toBe(NOT_APPLICABLE);
    expect(normalizeAnswerForStorage(undefined)).toBe(NOT_APPLICABLE);
    expect(normalizeAnswerForStorage('')).toBe(NOT_APPLICABLE);
    expect(normalizeAnswerForStorage('   ')).toBe(NOT_APPLICABLE);
  });
  test('explicit skip markers collapse to the sentinel', () => {
    expect(normalizeAnswerForStorage('not applicable')).toBe(NOT_APPLICABLE);
    expect(normalizeAnswerForStorage('not_applicable')).toBe(NOT_APPLICABLE);
    expect(normalizeAnswerForStorage('N/A')).toBe(NOT_APPLICABLE);
  });
  test('real answers pass through — including 0 and legitimate "None"', () => {
    expect(normalizeAnswerForStorage(0)).toBe(0);
    expect(normalizeAnswerForStorage(4)).toBe(4);
    expect(normalizeAnswerForStorage('None of the above')).toBe('None of the above');
    expect(normalizeAnswerForStorage(['A', 'C'])).toEqual(['A', 'C']);
    expect(normalizeAnswerForStorage({ best: 'X', worst: 'Y' })).toEqual({ best: 'X', worst: 'Y' });
    // [] is "answered, endorsed nothing" — a real multi-select response, not a skip.
    expect(normalizeAnswerForStorage([])).toEqual([]);
  });
  test('never returns null/undefined', () => {
    for (const v of [null, undefined, '', [], 'n/a', 'Yes', 3, 0]) {
      expect(normalizeAnswerForStorage(v)).not.toBeNull();
      expect(normalizeAnswerForStorage(v)).not.toBeUndefined();
    }
  });
});

describe('isSkip', () => {
  test('sentinel / null / empty are skips; real values are not', () => {
    expect(isSkip(NOT_APPLICABLE)).toBe(true);
    expect(isSkip(null)).toBe(true);
    expect(isSkip('')).toBe(true);
    expect(isSkip([])).toBe(false); // "endorsed nothing" is a real respondent, not a skip
    expect(isSkip(0)).toBe(false); // 0 is a real rating answer
    expect(isSkip('Yes')).toBe(false);
    expect(isSkip(['A'])).toBe(false);
  });
});

describe('analysis excludes the skip from distributions + denominators', () => {
  test('shared.distribution() drops the sentinel', () => {
    const rows = [
      { answer: 'Yes' }, { answer: 'Yes' }, { answer: 'No' },
      { answer: NOT_APPLICABLE }, { answer: null },
    ];
    const dist = distribution(rows);
    expect(dist).toEqual({ Yes: 2, No: 1 });
    expect(dist[NOT_APPLICABLE]).toBeUndefined();
  });

  test('ratingStats ignores the sentinel (mean over real numbers only)', () => {
    const rows = [{ answer: 4 }, { answer: 2 }, { answer: NOT_APPLICABLE }];
    const s = ratingStats(rows);
    expect(s.n).toBe(2);
    expect(s.mean).toBe(3);
  });

  test('insights.aggregate() single-select: skip is not a bar and not in n', () => {
    const questions = [{ id: 'q1', type: 'single', text: 'Recall the ad?', options: ['Yes', 'No'] }];
    const responses = [
      { question_id: 'q1', answer: 'Yes' },
      { question_id: 'q1', answer: 'Yes' },
      { question_id: 'q1', answer: 'No' },
      { question_id: 'q1', answer: NOT_APPLICABLE }, // skipped — not recalled
    ];
    const byQ = aggregate(responses, questions);
    expect(byQ.q1.n).toBe(3); // denominator excludes the skip
    expect(byQ.q1.distribution).toEqual({ Yes: 2, No: 1 });
    expect(byQ.q1.distribution[NOT_APPLICABLE]).toBeUndefined();
  });

  test('insights.aggregate() multi-select: skip excluded from n_respondents denominator', () => {
    const questions = [{ id: 'q2', type: 'multi', text: 'Which channels?', options: ['TV', 'Social'] }];
    const responses = [
      { question_id: 'q2', answer: ['TV', 'Social'] },
      { question_id: 'q2', answer: ['TV'] },
      { question_id: 'q2', answer: NOT_APPLICABLE },
    ];
    const byQ = aggregate(responses, questions);
    expect(byQ.q2.n_respondents).toBe(2); // the skip is not a respondent to this question
    expect(byQ.q2.distribution).toEqual({ TV: 2, Social: 1 });
  });
});
