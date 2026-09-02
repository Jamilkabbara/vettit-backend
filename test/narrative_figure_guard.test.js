/*
 * Narrative figure guard — the prose may reference computed figures, never
 * invent them.
 *
 * Anchored on a REAL paid deliverable. Mission 3fc15087 (market_entry, n=80)
 * shipped this sentence as its q3 "what this means":
 *
 *   "57% say they probably would buy, and a further 3% say they definitely
 *    would buy, giving a combined positive intent of 60%, while only 19
 *    respondents (roughly 24%) lean toward not buying."
 *
 * The stored distribution for q3 is
 *   {"Probably would buy":57, "Definitely would buy":3, "Might or might not":1,
 *    "Probably would NOT buy":16, "Definitely would NOT buy":3}  (base 80)
 * so 57 respondents is 71%, not 57%; 3 is 4%, not 3%; and the combined positive
 * figure is 75%, not 60%. The "19 respondents (roughly 24%)" clause in the same
 * sentence is correct — the model contradicted itself mid-sentence.
 *
 * Both halves of the fix are covered here:
 *   (a) prevention — compactQuestionForPrompt hands the narrator the
 *       percentages and the base, so it never has to derive one;
 *   (b) detection  — checkNarrativeFigures rejects the sentence on the way out,
 *       and generateReportSummaries keeps the deterministic line instead.
 */

const path = require('path');
const {
  checkNarrativeFigures,
  distributionPercentages,
  achievableSums,
} = require('../src/services/report/narrativeFigures');
const {
  compactQuestionForPrompt,
  deterministicQuestionInsight,
} = require('../src/services/ai/reportSummaries');

const FIXTURES = require('./fixtures/completed_missions.json');
const byPrefix = (p) => FIXTURES.find((f) => f.mission_id_prefix === p);
const q = (prefix, qid) => byPrefix(prefix).report.survey.find((x) => x.id === qid);

// The exact string that shipped, and the exact question it shipped against.
const LIVE_Q3 = q('3fc15087', 'q3');
const LIVE_Q3_TEXT = '57% say they probably would buy, and a further 3% say they definitely would buy, '
  + 'giving a combined positive intent of 60%, while only 19 respondents (roughly 24%) lean toward not buying.';
const LIVE_Q4 = q('3fc15087', 'q4');
const LIVE_Q4_TEXT = '35% of respondents accept the premium price band (SAR 29-38 / EGP 151-200), making it '
  + 'the single most chosen tier, and stacking the super-premium band (10%) on top means 45% of buyers are '
  + 'willing to pay SAR 29 or more per serving.';

describe('the live defect', () => {
  test('the fixture really is the shipped distribution (57 of 80 = 71%, not 57%)', () => {
    expect(LIVE_Q3.data.n).toBe(80);
    expect(LIVE_Q3.data.distribution['Probably would buy']).toBe(57);
    expect(LIVE_Q3.data.distribution['Definitely would buy']).toBe(3);
    expect(Math.round((57 / 80) * 100)).toBe(71);
    expect(Math.round((3 / 80) * 100)).toBe(4);
  });

  test('rejects the sentence a customer screenshotted', () => {
    const r = checkNarrativeFigures(LIVE_Q3_TEXT, LIVE_Q3);
    expect(r.checked).toBe(true);
    expect(r.ok).toBe(false);
    const claims = r.violations.map((v) => v.claim);
    expect(claims).toContain('57%');   // count printed as a percent
    expect(claims).toContain('3%');    // count printed as a percent
    expect(claims).toContain('60%');   // no subset of the answers is 60% of 80
    expect(r.violations.find((v) => v.claim === '57%').rule).toBe('count_as_percent');
    expect(r.violations.find((v) => v.claim === '60%').rule).toBe('underivable_percent');
  });

  test('does NOT flag the one clause the model got right', () => {
    // "19 respondents (roughly 24%)" is correct: 16 + 3 = 19, and 19/80 = 24%.
    const claims = checkNarrativeFigures(LIVE_Q3_TEXT, LIVE_Q3).violations.map((v) => v.claim);
    expect(claims).not.toContain('24%');
    expect(claims.some((c) => c.includes('19'))).toBe(false);
  });

  test('rejects q4 of the same mission (the owner had not spotted this one)', () => {
    const r = checkNarrativeFigures(LIVE_Q4_TEXT, LIVE_Q4);
    expect(r.ok).toBe(false);
    const claims = r.violations.map((v) => v.claim);
    expect(claims).toContain('35%'); // 35 respondents is 44%, not 35%
    expect(claims).toContain('45%'); // no subset of the answers is 45% of 80
  });

  test('KNOWN HOLE: a count that collides with its own share is not caught', () => {
    // "the super-premium band (10%)" means the COUNT 10, which is 12.5% of 80.
    // But 8 respondents IS exactly 10% of 80, so the claim is arithmetically
    // indistinguishable from a true one. Documented, not fixed — the sentence is
    // still rejected because 35% and 45% in it are not.
    const claims = checkNarrativeFigures(LIVE_Q4_TEXT, LIVE_Q4).violations.map((v) => v.claim);
    expect(claims).not.toContain('10%');
  });
});

describe('accepts honest prose', () => {
  test('the deterministic line for the same question passes its own guard', () => {
    // deterministicQuestionInsight is grounded by construction; if the guard
    // rejected it, the guard would be wrong.
    for (const f of FIXTURES) {
      for (const sq of f.report.survey) {
        const line = deterministicQuestionInsight(sq);
        const r = checkNarrativeFigures(line, sq);
        if (r.checked && !r.ok) {
          throw new Error(`guard rejected its own computed line for ${f.mission_id_prefix}/${sq.id}: `
            + `"${line}" -> ${JSON.stringify(r.violations)}`);
        }
      }
    }
  });

  test('a correctly-stated version of the live sentence passes', () => {
    const fixed = '71% say they probably would buy and a further 4% definitely would, giving combined '
      + 'positive intent of 75%, while 19 respondents (24%) lean toward not buying.';
    expect(checkNarrativeFigures(fixed, LIVE_Q3).ok).toBe(true);
  });

  test('a percentage that is part of the QUESTION is not a claim about answers', () => {
    // Mission 34c57e35 q13 asks about "a 20% price increase". Echoing it is not
    // an assertion that 20% of respondents did anything.
    const q13 = q('34c57e35', 'q13');
    const text = 'Switching likelihood after a 20% price increase averages 3.4 out of 5.';
    expect(checkNarrativeFigures(text, q13).ok).toBe(true);
  });

  test('a stated confidence level is not a share of respondents', () => {
    const sq = { renderer: 'scale_1_5_star', text: 'How likely?', data: { n: 5, scale_min: 1, scale_max: 5, distribution: { 3: 2, 4: 3 } } };
    expect(checkNarrativeFigures('A 95% confidence interval of 3.1 to 4.1.', sq).ok).toBe(true);
  });

  test('multi-select complements are honest ("2 of 5 did NOT recognise it")', () => {
    // ded496c4 q4: {RideNow:3, Careem:5, Uber:5} over 5 respondents. "2" is not a
    // subset sum of overlapping selections, but 5 - 3 = 2 is a real headcount.
    const q4 = q('ded496c4', 'q4');
    expect(checkNarrativeFigures('Only 3 of 5 respondents would consider RideNow.', q4).ok).toBe(true);
    const q3 = q('4515fed5', 'q3');
    expect(checkNarrativeFigures('2 of 5 respondents did not recognize it.', q3).ok).toBe(true);
  });

  test('rating idiom "4 out of 5 stars" is scale talk, not a base claim', () => {
    const sq = q('9998fe9d', 'q2');
    expect(checkNarrativeFigures('All 5 respondents rated the concept exactly 4 out of 5.', sq).ok).toBe(true);
  });

  test('a question with no honest denominator is reported unchecked, not passed', () => {
    const openEnd = FIXTURES.flatMap((f) => f.report.survey).find((x) => x.renderer === 'open_text_verbatims');
    expect(openEnd).toBeTruthy();
    expect(checkNarrativeFigures('Thirty verbatims were collected.', openEnd).checked).toBe(false);
  });
});

describe('achievableSums', () => {
  test('exact subset sums, complements handled by the caller', () => {
    expect([...achievableSums([16, 3, 1, 3, 57])].sort((a, b) => a - b))
      .toEqual([0, 1, 3, 4, 6, 7, 16, 17, 19, 20, 22, 23, 57, 58, 60, 61, 63, 64, 73, 74, 76, 77, 79, 80]);
  });
  test('ignores zero and non-integer buckets without throwing', () => {
    expect(achievableSums([0, 2, 0]).has(2)).toBe(true);
  });
});

describe('prevention: the narrator is handed the percentages', () => {
  test('single_select payload now carries a base and pre-computed shares', () => {
    const compact = compactQuestionForPrompt(LIVE_Q3);
    expect(compact.base_respondents).toBe(80);
    expect(compact.distribution_counts['Probably would buy']).toBe(57);
    // The number the model was previously forced to derive is now given to it.
    expect(compact.distribution_pct['Probably would buy']).toBe(71);
    expect(compact.distribution_pct['Definitely would buy']).toBe(4);
  });

  test('every percentage handed over is one the guard would accept', () => {
    for (const f of FIXTURES) {
      for (const sq of f.report.survey) {
        const p = distributionPercentages(sq.data, sq.renderer);
        if (!p) continue;
        for (const [label, v] of Object.entries(p.pct)) {
          const r = checkNarrativeFigures(`A share of ${v}% chose it.`, sq);
          if (r.checked && !r.ok) {
            throw new Error(`prompt would hand over ${v}% for ${f.mission_id_prefix}/${sq.id} "${label}" `
              + `but the guard rejects it: ${JSON.stringify(r.violations)}`);
          }
        }
      }
    }
  });

  test('multi_select denominates on respondents, not on total selections', () => {
    const q5 = q('3fc15087', 'q5');
    expect(q5.renderer).toBe('multi_select');
    const compact = compactQuestionForPrompt(q5);
    expect(compact.base_respondents).toBe(q5.data.n_respondents);
    // selections sum well past the respondent count; shares must still be <= 100
    expect(Math.max(...Object.values(compact.distribution_pct))).toBeLessThanOrEqual(100);
  });
});

describe('regression corpus: 66 completed production missions', () => {
  test('flags exactly the questions whose shipped narrative is arithmetically wrong', () => {
    const flagged = [];
    for (const f of FIXTURES) {
      for (const sq of f.report.survey) {
        if (typeof sq.insight !== 'string' || !sq.insight) continue;
        const r = checkNarrativeFigures(sq.insight, sq);
        if (r.checked && !r.ok) flagged.push(`${f.mission_id_prefix}/${sq.id}`);
      }
    }
    // Verified by hand against the stored distributions — every one of these is
    // a real arithmetic error in text that shipped to a paying customer.
    expect(flagged).toEqual(expect.arrayContaining([
      '3fc15087/q3',   // 57% / 3% / 60%
      '3fc15087/q4',   // 35% / 45%
      'bdae4d45/q3',   // "the majority (21 of 60) gave this a 1" — truth 16
      'bdae4d45/q4',   // "45 of 60 rated 4 or 5" — truth 41
      '0a494ef7/q2',   // "233 of 300 respondents" — the base is 125
    ]));
    // ...and does NOT fire on the missions whose narrative is sound.
    expect(flagged.filter((x) => x.startsWith('30e1de33/'))).toEqual([]);
    expect(flagged.filter((x) => x.startsWith('86d4b8c6/'))).toEqual([]);
  });
});
