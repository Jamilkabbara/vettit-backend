/* Pass 49 Phase 3 — report summary generator (deterministic floor + honesty guard). */
const {
  deterministicQuestionInsight,
  deterministicExecSummary,
  deterministicRecommendations,
  referencesData,
} = require('../src/services/ai/reportSummaries');

const NO_HEDGE = /unavailable|apolog|as an ai|being finalized/i;

describe('deterministicQuestionInsight', () => {
  test('scale: factual top/bottom box, no editorial tone, grounded', () => {
    const q = { id: 'q2', number: 2, renderer: 'scale_0_10',
      data: { scale_min: 0, scale_max: 10, average: 7, n: 5, distribution: { 6: 1, 7: 3, 8: 1 } } };
    const s = deterministicQuestionInsight(q);
    expect(s).toMatch(/Average 7 out of 10 \(n=5\)/);
    expect(s).not.toMatch(/strongly positive|signal is/i); // no contradicting tone
    expect(NO_HEDGE.test(s)).toBe(false);
    expect(referencesData(s, q)).toBe(true);
  });
  test('single_select: leading option + share', () => {
    const q = { id: 'q4', number: 4, renderer: 'single_select',
      data: { distribution: { Satisfied: 4, Dissatisfied: 1 } } };
    const s = deterministicQuestionInsight(q);
    expect(s).toMatch(/Satisfied/);
    expect(s).toMatch(/80%/);
    expect(referencesData(s, q)).toBe(true);
  });
  test('single_select: flags no-majority', () => {
    const q = { id: 'q', number: 1, renderer: 'single_select',
      data: { distribution: { A: 2, B: 2, C: 1 } } };
    expect(deterministicQuestionInsight(q)).toMatch(/no option reached a majority/);
  });
  test('multi_select: most-selected with respondent base', () => {
    const q = { id: 'q', number: 1, renderer: 'multi_select',
      data: { n_respondents: 5, distribution: { Price: 5, Features: 2 } } };
    const s = deterministicQuestionInsight(q);
    expect(s).toMatch(/Price/); expect(s).toMatch(/100% of 5/);
  });
  test('verbatims: qualitative pointer, always accepted by guard', () => {
    const q = { id: 'q', number: 1, renderer: 'open_text_verbatims', data: { verbatims: ['a', 'b'] } };
    const s = deterministicQuestionInsight(q);
    expect(s).toMatch(/2 open-text responses/);
    expect(referencesData(s, q)).toBe(true);
  });
  test('every renderer returns a non-empty grounded string', () => {
    for (const r of ['scale_1_7', 'multi_select', 'attribute_battery', 'max_diff', 'single_select', 'forced_choice', 'screener']) {
      const q = { id: 'x', number: 1, renderer: r, data: { distribution: { Opt: 3 }, best: { F: 2 }, worst: { G: 1 }, scale_min: 1, scale_max: 7, average: 4, n: 3 } };
      expect(deterministicQuestionInsight(q).length).toBeGreaterThan(5);
    }
  });
});

describe('deterministicExecSummary', () => {
  test('hedge-free, leads with headline, carries directional posture at low n', () => {
    const report = {
      headline: { metric: 'NPS', value: '-20', all: [{ label: 'NPS', value: '-20' }, { label: 'CSAT', value: '80%' }] },
      key_findings: [{ title: 'App crashes are the top complaint' }],
      header: { sample: { n: 5, posture: 'directional' } },
    };
    const s = deterministicExecSummary(report);
    expect(s).toMatch(/NPS: -20/);
    expect(NO_HEDGE.test(s)).toBe(false);
    expect(s).toMatch(/directional/);
  });
});

describe('deterministicRecommendations — direction-aware (no mis-signed floor)', () => {
  // Mirrors the live misfire on roadmap mission d51e09ad: the old floor called a
  // -0.84 anti-feature and a utility-0 indifferent feature "among the strongest
  // signals". Three buckets now: prioritise / drop / hold.
  const roadmap = {
    centerpiece: { methodology: 'roadmap', data: { methodology: 'roadmap', maxdiff: { features: [
      { feature_id: 'f1', label: 'Shared Wallets', utility: 1 },
      { feature_id: 'f2', label: 'Bill Reminders', utility: 0.1778 },
      { feature_id: 'f3', label: 'Investment Tracking', utility: 0 },
      { feature_id: 'f4', label: 'Offline Mode', utility: -0.3556 },
      { feature_id: 'f5', label: 'Cash-Back Rewards', utility: -0.84 },
    ] } } },
    headline: { metric: 'MaxDiff: Shared Wallets', value: 'utility 1', all: [] },
    header: { sample: { n: 5, posture: 'directional' } },
    survey: [],
  };

  test('never frames a negative / near-zero utility as "among the strongest signals"', () => {
    const recs = deterministicRecommendations(roadmap);
    const joined = recs.join(' | ');
    expect(joined).not.toMatch(/among the strongest signals/i);
    expect(joined).not.toMatch(/Prioritise[^|]*Cash-Back/i); // the -0.84 anti-feature is never a "build" rec
  });

  test('strong positive → prioritise; strong negative → drop; near-zero → hold', () => {
    const recs = deterministicRecommendations(roadmap);
    expect(recs.some((r) => /^Prioritise Shared Wallets \(\+1\)/.test(r))).toBe(true);
    expect(recs.some((r) => /Drop or defer .*Cash-Back Rewards \(-0\.84\).*Offline Mode \(-0\.36\)/.test(r))).toBe(true);
    expect(recs.some((r) => /Hold .*Investment Tracking.* low priority/i.test(r))).toBe(true);
  });

  test('generic (non-ranked) path leads with the headline + neutral secondaries, no false claim', () => {
    const sat = {
      centerpiece: { methodology: 'satisfaction', data: { methodology: 'satisfaction', nps: { score: -20 } } },
      headline: { metric: 'NPS', value: '-20', all: [{ label: 'NPS', value: '-20' }, { label: 'CSAT (top-2-box)', value: '80%' }] },
      header: { sample: { n: 30, posture: 'indicative' } },
      survey: [],
    };
    const recs = deterministicRecommendations(sat);
    expect(recs.join(' | ')).not.toMatch(/among the strongest signals/i);
    expect(recs[0]).toMatch(/headline finding \(NPS: -20\)/);
    expect(recs.some((r) => /Factor in CSAT \(top-2-box\) \(80%\)/.test(r))).toBe(true);
  });
});

describe('referencesData honesty guard', () => {
  const q = { id: 'q2', renderer: 'scale_0_10', data: { scale_max: 10, average: 7, n: 5, distribution: { 7: 3, 8: 2 } } };
  test('rejects a hallucinated insight with no real figure', () => {
    expect(referencesData('Respondents were overwhelmingly enthusiastic about the brand experience overall.', q)).toBe(false);
  });
  test('accepts an insight citing a real figure', () => {
    expect(referencesData('The average rating was 7 out of 10, with most clustering at the top.', q)).toBe(true);
  });
  test('accepts an insight citing a real option label', () => {
    const cq = { id: 'q', renderer: 'single_select', data: { distribution: { Satisfied: 4, Dissatisfied: 1 } } };
    expect(referencesData('Most respondents reported being Satisfied with the service.', cq)).toBe(true);
  });
  test('does not match a digit embedded in an unrelated number', () => {
    const dq = { id: 'q', renderer: 'single_select', data: { distribution: { A: 5 } } };
    expect(referencesData('In the year 2025 the market shifted dramatically toward mobile.', dq)).toBe(false);
  });
});
