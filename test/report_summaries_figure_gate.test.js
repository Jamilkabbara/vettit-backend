/*
 * END-TO-END gate check on generateReportSummaries.
 *
 * Feeds the generator the EXACT text mission 3fc15087 shipped, and the exact
 * fabricated tile mission e18c9802 shipped, with the Anthropic client mocked so
 * the model output is fixed. The assertions are on what gets CACHED onto
 * insights.per_question_insights / insights.kpis — i.e. what a customer sees.
 *
 * Mutation check: revert either gate in reportSummaries.js and these fail.
 * See PR body for the measured numbers.
 */

jest.mock('../src/services/ai/anthropic', () => ({ callClaude: jest.fn(), extractJSON: jest.fn() }));
const { callClaude } = require('../src/services/ai/anthropic');
const { generateReportSummaries } = require('../src/services/ai/reportSummaries');

const FIXTURES = require('./fixtures/completed_missions.json');
const ME = FIXTURES.find((f) => f.mission_id_prefix === '3fc15087');

const BAD_Q3 = '57% say they probably would buy, and a further 3% say they definitely would buy, '
  + 'giving a combined positive intent of 60%, while only 19 respondents (roughly 24%) lean toward not buying.';
const GOOD_Q4 = 'The premium band was the single most chosen tier, taken by 35 of 80 respondents.';

/** A report shaped like the real one but with only the two questions under test. */
function reportWith(qids) {
  return {
    ...ME.report,
    survey: ME.report.survey.filter((q) => qids.includes(q.id)),
  };
}

/** Mock the two calls generateReportSummaries makes: exec/kpi/rec, then per-question. */
function mockCalls({ kpis = [], perQuestion = {} }) {
  callClaude.mockReset();
  callClaude
    .mockResolvedValueOnce({ text: JSON.stringify({
      executive_summary: 'Purchase intent is the story of this study and it is broadly positive across both markets.',
      kpis,
      recommendations: [],
    }) })
    .mockResolvedValue({ text: JSON.stringify(perQuestion) });
}

describe('per-question narrative gate', () => {
  test('the sentence that shipped is NOT cached; the computed line is', async () => {
    mockCalls({ perQuestion: { q3: BAD_Q3 } });
    const out = await generateReportSummaries(reportWith(['q3']), { missionId: 'test' });
    const pq = out.per_question_insights.find((p) => p.question_id === 'q3');

    expect(pq.insight).not.toBe(BAD_Q3);
    expect(pq.source).toBe('computed');
    // The deterministic line the customer should have received all along.
    expect(pq.insight).toMatch(/Probably would buy/);
    expect(pq.insight).toMatch(/71%/);
    expect(pq.insight).toMatch(/57 of 80/);
    // and it must not contain the fabricated figures
    expect(pq.insight).not.toMatch(/\b57%/);
    expect(pq.insight).not.toMatch(/\b60%/);
  });

  test('an arithmetically sound sentence IS cached as ai', async () => {
    mockCalls({ perQuestion: { q4: GOOD_Q4 } });
    const out = await generateReportSummaries(reportWith(['q4']), { missionId: 'test' });
    const pq = out.per_question_insights.find((p) => p.question_id === 'q4');
    expect(pq.insight).toBe(GOOD_Q4);
    expect(pq.source).toBe('ai');
  });

  test('the gate is per-question: one bad sentence does not discard a good one', async () => {
    mockCalls({ perQuestion: { q3: BAD_Q3, q4: GOOD_Q4 } });
    const out = await generateReportSummaries(reportWith(['q3', 'q4']), { missionId: 'test' });
    const bySrc = Object.fromEntries(out.per_question_insights.map((p) => [p.question_id, p.source]));
    expect(bySrc.q3).toBe('computed');
    expect(bySrc.q4).toBe('ai');
  });
});

describe('FAIL SAFE: an advisory finding must not rewrite the deliverable', () => {
  const AP = FIXTURES.find((f) => f.mission_id_prefix === '0a494ef7');
  const TRUE_SENTENCE = 'All 300 respondents confirmed their organisation regularly commissions '
    + 'or uses market research, making this a fully qualified sample of active buyers.';

  test('mission 0a494ef7 q1: the true sentence is cached as ai, untouched', async () => {
    const report = { ...AP.report, survey: AP.report.survey.filter((q) => q.id === 'q1') };
    mockCalls({ perQuestion: { q1: TRUE_SENTENCE } });
    const out = await generateReportSummaries(report, { missionId: 'test' });
    const pq = out.per_question_insights.find((p) => p.question_id === 'q1');
    expect(pq.insight).toBe(TRUE_SENTENCE);
    expect(pq.source).toBe('ai');
  });

  test('an advisory-only violation keeps the model line rather than substituting', async () => {
    // bdae4d45 q3 genuinely says "21 of 60" where the true count is 16 - but
    // that is an underivable_count, which is advisory. It must be LOGGED and
    // KEPT, not swapped for the deterministic line.
    const BD = FIXTURES.find((f) => f.mission_id_prefix === 'bdae4d45');
    const report = { ...BD.report, survey: BD.report.survey.filter((q) => q.id === 'q3') };
    const line = BD.report.survey.find((q) => q.id === 'q3').insight;
    mockCalls({ perQuestion: { q3: line } });
    const out = await generateReportSummaries(report, { missionId: 'test' });
    const pq = out.per_question_insights.find((p) => p.question_id === 'q3');
    expect(pq.insight).toBe(line);
    expect(pq.source).toBe('ai');
  });
});

describe('prevention: the prompt now carries the percentages', () => {
  test('the per-question call is handed distribution_pct and a base, and told not to derive', async () => {
    mockCalls({ perQuestion: {} });
    await generateReportSummaries(reportWith(['q3']), { missionId: 'test' });
    const perQCall = callClaude.mock.calls[1][0];
    const body = perQCall.messages[0].content;

    expect(body).toMatch(/distribution_pct/);
    expect(body).toMatch(/base_respondents/);
    expect(body).toMatch(/NEVER write a count from distribution_counts with a % sign/);
    // the actual figure it previously had to derive, now handed over
    const payload = JSON.parse(body.slice(body.indexOf('[{')));
    expect(payload[0].base_respondents).toBe(80);
    expect(payload[0].distribution_pct['Probably would buy']).toBe(71);
  });
});

describe('hero tile gate', () => {
  test('a tile carrying a figure the server never computed is dropped', async () => {
    mockCalls({ kpis: [
      { label: 'Sample Completion Rate', value: '38% (10 of 26 collected)', trend: 'negative' },
      { label: 'Purchase Intent (top-2-box)', value: '75%', trend: 'positive' },
    ] });
    const out = await generateReportSummaries(reportWith(['q3']), { missionId: 'test' });
    const values = out.kpis.map((k) => k.value);
    expect(values).not.toContain('38% (10 of 26 collected)');
    expect(values).toContain('75%'); // 57 + 3 of 80 = 75%, a computed figure
  });

  test('dropping a fabricated tile backfills from the analysis-derived tiles', async () => {
    mockCalls({ kpis: [{ label: 'Invented', value: '38% (10 of 26 collected)', trend: 'neutral' }] });
    const out = await generateReportSummaries(reportWith(['q3']), { missionId: 'test' });
    expect(out.kpis.length).toBeGreaterThan(0);
    expect(out.kpis.map((k) => k.label)).not.toContain('Invented');
  });
});
