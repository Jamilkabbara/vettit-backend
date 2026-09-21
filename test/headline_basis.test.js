/**
 * The headline belongs to the whole study; a subgroup figure says whose.
 *
 * The fixture is a real shape: mission 3fc15087, n=80 across Saudi Arabia and
 * Egypt, where purchase intent was 75% overall and 82.5% in Saudi Arabia. Both
 * figures are real and both are derivable from the data, so neither the
 * narrative guard nor the tile guard can tell them apart. Only the basis can.
 *
 * (That report attributed its 82.5% correctly. The sentences below are written
 * to test both readings of the same true number.)
 */

const {
  checkHeadlineBasis, fullSampleFigures, subgroupFigureMap, subgroupLabels, checkAgainstReport,
} = require('../src/services/report/headlineBasis');

/** The stored q3 distribution, exactly as delivered. */
const REPORT = {
  header: { sample: { n: 80, qualified: 80, delivered: 80 }, markets: 'Saudi Arabia and Egypt' },
  survey: [{
    id: 'q3',
    type: 'single',
    data: {
      n_respondents: 80,
      distribution: {
        'Definitely would buy': 3,
        'Probably would buy': 57,
        'Might or might not': 1,
        'Probably would NOT buy': 16,
        'Definitely would NOT buy': 3,
      },
    },
  }],
};

/** Per-market analysis: where 82.5% legitimately lives. */
const ANALYSIS = {
  demand_index: 62,
  purchase_intent_pct: 75,
  by_market: [
    { market: 'Saudi Arabia', code: 'SA', n: 40, purchase_intent_pct: 82.5 },
    { market: 'Egypt', code: 'EG', n: 40, purchase_intent_pct: 67.5 },
  ],
};

const ctx = () => ({
  full: fullSampleFigures(REPORT),
  subgroupMap: subgroupFigureMap(ANALYSIS),
  labels: subgroupLabels(ANALYSIS, REPORT),
});

describe('an unlabelled subgroup figure', () => {
  test('is caught, and named for what it is', () => {
    const v = checkHeadlineBasis(
      'Premium plant-based ready-meals show real demand, scoring a demand index of 62/100 and purchase intent of 82.5%.',
      ctx(),
    );
    expect(v).toHaveLength(1);
    expect(v[0].figure).toBe(82.5);
    expect(v[0].reason).toMatch(/whole-study/);
    expect(v[0].belongsTo).toContain('saudi arabia');
  });

  test('the same figure passes once it says whose it is', () => {
    for (const ok of [
      'Purchase intent reaches 82.5% among Saudi respondents.',
      'In the Saudi Arabia market, purchase intent is 82.5%.',
      'Saudi respondents report 82.5% intent, against 67.5% in Egypt.',
      'Purchase intent is 82.5% for the Saudi segment (n=40).',
    ]) {
      expect(checkHeadlineBasis(ok, ctx())).toEqual([]);
    }
  });

  test('the whole-study figure is never flagged', () => {
    for (const ok of [
      'Purchase intent is 75% across the study.',
      'Three quarters of respondents (75%) would probably or definitely buy.',
      '71% say they probably would buy.',            // 57 of 80, a real whole-sample share
    ]) {
      expect(checkHeadlineBasis(ok, ctx())).toEqual([]);
    }
  });

  test('a two-letter market code cannot be matched inside an ordinary word', () => {
    // "same" contains "sa"; that must not count as naming the Saudi market.
    const v = checkHeadlineBasis('Purchase intent is 82.5% and the same pattern holds.', ctx());
    expect(v).toHaveLength(1);
  });
});

describe('scope of the check', () => {
  test('an invented figure is left to the narrative guard, not double-reported here', () => {
    // 91% is in neither set: this check stays silent, narrativeFigures owns it.
    expect(checkHeadlineBasis('Purchase intent is 91%.', ctx())).toEqual([]);
  });

  test('counts without a percentage are not headline claims', () => {
    expect(checkHeadlineBasis('33 of 40 Saudi respondents would buy.', ctx())).toEqual([]);
  });

  test('a multi-sentence summary reports each offending sentence once', () => {
    const text = 'Demand is strong at 82.5%. Egypt is weaker. Intent across the study is 75%.';
    const v = checkAgainstReport(text, REPORT, ANALYSIS);
    expect(v).toHaveLength(1);
    expect(v[0].sentence).toContain('82.5%');
  });

  test('no analysis means nothing to compare, and no false alarms', () => {
    expect(checkAgainstReport('Purchase intent is 82.5%.', REPORT, null)).toEqual([]);
  });
});
