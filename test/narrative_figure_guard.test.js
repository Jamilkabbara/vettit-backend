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

describe('FAIL SAFE: a correct sentence must survive, even against a bad base', () => {
  /*
   * The regression this section exists for. Mission 0a494ef7 has 300 distinct
   * personas and 2400 response rows, and its q1 insight reads:
   *
   *   "All 300 respondents confirmed their organisation regularly commissions
   *    or uses market research, making this a fully qualified sample of active
   *    buyers."
   *
   * That is TRUE on both the figure and the claim. An earlier version of this
   * guard called it a fabricated sample size, because the AUDIT SCRIPT read the
   * mission through an unpaginated `.limit(5000)` query - Supabase caps a single
   * request at 1000 rows, and 1000 / 8 questions = a phantom base of 125.
   * (The production pipeline was never affected: it reads through
   * src/db/fetchAllResponses.js, which pages. The audit bypassed it.)
   *
   * The lesson is not "fix the script". It is that a validator must not
   * destructively act on a base it has not corroborated, because suppressing a
   * correct sentence is silent and degrades output that was already right.
   */
  const AP = byPrefix('0a494ef7');
  const TRUE_SENTENCE = 'All 300 respondents confirmed their organisation regularly commissions '
    + 'or uses market research, making this a fully qualified sample of active buyers.';

  test('the fixture is captured through the paginated fetch, not a capped query', () => {
    expect(AP.raw_response_rows).toBe(2400);
    expect(AP.raw_distinct_personas).toBe(300);
    expect(AP.report.header.sample.n).toBe(300);
    const q1 = AP.report.survey.find((x) => x.id === 'q1');
    expect(q1.data.n).toBe(300); // NOT 125
  });

  test('against the real base, the true sentence is clean', () => {
    const q1 = AP.report.survey.find((x) => x.id === 'q1');
    const r = checkNarrativeFigures(TRUE_SENTENCE, q1, 300);
    expect(r.ok).toBe(true);
    expect(r.substitutable).toBe(false);
  });

  test('against a TRUNCATED base the sentence is still never substituted', () => {
    // Reconstruct exactly what the capped query produced: 125 of everything.
    const truncated = {
      id: 'q1', renderer: 'screener', text: 'Does your organisation commission market research?',
      data: { n: 125, distribution: { 'Yes, we regularly commission or use market research': 125 } },
    };
    const r = checkNarrativeFigures(TRUE_SENTENCE, truncated, 125);
    // It may well flag - it is looking at a wrong denominator - but it must NOT
    // be allowed to rewrite the deliverable on the strength of it.
    expect(r.substitutable).toBe(false);
    for (const v of r.violations) expect(v.enforceable).toBe(false);
  });

  test('an unconfirmed base blocks substitution even for an enforcing rule', () => {
    // Counts sum to 25 while the stated base is 10 (mission af36a36d q1's real
    // shape). The base cannot be corroborated, so nothing is substituted.
    const q = {
      id: 'q1', renderer: 'screener', text: 'Which of these brands have you heard of?',
      data: { n: 10, distribution: { 'Al Marai': 10, Nadec: 9, 'Almarai Flavored Milk': 6 } },
    };
    const r = checkNarrativeFigures('Nadec reached 88% awareness.', q, 10);
    expect(r.baseConfirmed).toBe(false);
    expect(r.substitutable).toBe(false);
  });

  test('advisory rules never substitute, on their own or together', () => {
    const q = {
      id: 'q', renderer: 'single_select', text: 'How often?',
      data: { n: 60, distribution: { A: 37, B: 10, C: 5, D: 8 } },
    };
    const r = checkNarrativeFigures('The two largest groups are 23 respondents and 22 respondents.', q, 60);
    expect(r.ok).toBe(false);                 // it IS wrong (truth 37 and 10)
    expect(r.baseConfirmed).toBe(true);
    expect(r.substitutable).toBe(false);      // ...but advisory-only, so kept
    expect(r.violations.every((v) => !v.enforceable)).toBe(true);
  });
});

describe('regression corpus: 66 completed production missions', () => {
  test('substitutes only where the figure is provably wrong on a confirmed base', () => {
    const substituted = [];
    const advisory = [];
    for (const f of FIXTURES) {
      for (const sq of f.report.survey) {
        if (typeof sq.insight !== 'string' || !sq.insight) continue;
        const r = checkNarrativeFigures(sq.insight, sq, f.report.header.sample.n);
        if (!r.checked) continue;
        if (r.substitutable) substituted.push(`${f.mission_id_prefix}/${sq.id}`);
        else if (!r.ok) advisory.push(`${f.mission_id_prefix}/${sq.id}`);
      }
    }
    // Each of these was re-verified against raw mission_responses: the stated
    // percentage is not any share the answers can produce.
    expect(substituted).toEqual(expect.arrayContaining([
      '3fc15087/q3',  // "57%" is the count 57; the share is 71%
      '3fc15087/q4',  // "35%" is the count 35; the share is 44%
      'b8f5abce/q1',  // "57% purchase occasionally"; the share is 71%
      'b8f5abce/q3',  // "63%" combined; the true combined share is 79%
      '23389bb1/q1',  // "50% maybe"; the true share is 80%
    ]));
    // 0a494ef7's narrative is CORRECT and must never appear here.
    expect(substituted.filter((x) => x.startsWith('0a494ef7/'))).toEqual([]);
    expect(advisory.filter((x) => x.startsWith('0a494ef7/'))).toEqual([]);
    // Sound missions stay clean end to end.
    expect(substituted.filter((x) => x.startsWith('30e1de33/'))).toEqual([]);
    expect(substituted.filter((x) => x.startsWith('86d4b8c6/'))).toEqual([]);
  });

  test('advisory findings are surfaced, not silently dropped', () => {
    // bdae4d45 q3 really does say "21 of 60" where the true count is 16. The
    // guard must SEE it (so it reaches the log) while refusing to act on it.
    const f = byPrefix('bdae4d45');
    const q3 = f.report.survey.find((x) => x.id === 'q3');
    const r = checkNarrativeFigures(q3.insight, q3, f.report.header.sample.n);
    expect(r.ok).toBe(false);
    expect(r.substitutable).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain('underivable_count');
  });
});
