/* Export/render audit (eb41b384): D3 WTP band, D5 methodology label, D6
 * multi-select canonical merge. (D1/D2 are PPTX layout — visually verified.) */
const { shapeQuestionData, buildCanonicalReport } = require('../src/services/report/buildReport');
const { computeMarketEntry } = require('../src/services/analysis/marketEntry');

describe('D6 — multi-select answers merge back to canonical options', () => {
  const q = {
    id: 'q1', type: 'multi',
    options: [
      'Kiri / Almarai chilled food products (Saudi Arabia / Egypt)',
      'Sadia chilled or frozen ready-meals (available across both markets)',
      'None of the above',
    ],
  };
  const r = (answer) => ({ question_id: 'q1', answer });

  test('paraphrased / truncated variants collapse to one canonical bar', () => {
    const responses = [
      r(['Almarai chilled food products (Egypt)']),                                 // dropped "Kiri /" + diff parenthetical
      r(['Almarai chilled food products']),                                         // bare
      r(['Kiri / Almarai chilled food products (Saudi Arabia / Egypt)']),           // exact
      r(['Sadia chilled or frozen ready-meals']),                                   // parenthetical-stripped exact
      r(['Some totally different brand XYZ']),                                       // genuine non-option → kept
    ];
    const dist = shapeQuestionData(q, 'multi_select', responses, null).distribution;
    expect(dist['Kiri / Almarai chilled food products (Saudi Arabia / Egypt)']).toBe(3);
    expect(dist['Sadia chilled or frozen ready-meals (available across both markets)']).toBe(1);
    expect(dist['Some totally different brand XYZ']).toBe(1); // unmatched preserved (DQ still flags)
    expect(Object.keys(dist)).toHaveLength(3); // 3 canonical bars, not 5 fragments
  });

  test('no options → no canonicalization (unchanged behaviour)', () => {
    const dist = shapeQuestionData({ id: 'q1', type: 'multi', options: [] }, 'multi_select',
      [{ question_id: 'q1', answer: ['A'] }, { question_id: 'q1', answer: ['A '] }], null).distribution;
    expect(dist.A).toBe(1);
    expect(dist['A ']).toBe(1); // not merged when there are no options to map to
  });
});

describe('D5 — methodology_label maps the newest goal types', () => {
  const labelFor = (goal_type) => buildCanonicalReport({ id: 't', goal_type, questions: [] }, null, []).header.methodology_label;
  test('market_entry / audience_profiling get real labels, not "Research Study"', () => {
    expect(labelFor('market_entry')).toBe('Market Entry');
    expect(labelFor('audience_profiling')).toBe('Audience Profiling');
    expect(labelFor('pricing')).toBe('Pricing Study'); // unchanged
  });
});

describe('D3 — market_entry WTP reports the modal price band per market', () => {
  const questions = [
    { id: 'qs', kind: 'screener', isScreening: true },
    { id: 'qa', kind: 'appeal', type: 'rating' },
    { id: 'qi', kind: 'intent' },
    { id: 'qw', kind: 'wtp', type: 'single' },
  ];
  const resp = (pid, country, wtpAns) => ([
    { persona_id: pid, persona_profile: { country }, question_id: 'qi', answer: 'Definitely would buy' },
    { persona_id: pid, persona_profile: { country }, question_id: 'qa', answer: 6 },
    { persona_id: pid, persona_profile: { country }, question_id: 'qw', answer: wtpAns },
  ]);
  const DUAL_3140 = 'Saudi Arabia: SAR 31–40 per meal / Egypt: EGP 181–250 per meal';
  const DUAL_2130 = 'Saudi Arabia: SAR 21–30 per meal / Egypt: EGP 121–180 per meal';

  test('extracts this market\'s band from a dual-market label (was empty "—")', () => {
    const rows = [
      ...resp('p1', 'SA', DUAL_3140), ...resp('p2', 'SA', DUAL_3140), ...resp('p3', 'SA', DUAL_2130),
      ...resp('p4', 'EG', DUAL_2130), ...resp('p5', 'EG', DUAL_2130),
    ];
    const a = computeMarketEntry(rows, questions, { targeting: { geography: { countries: ['SA', 'EG'] } } });
    expect(a.markets.find((m) => m.market === 'SA').wtp).toBe('SAR 31–40'); // modal for SA
    expect(a.markets.find((m) => m.market === 'EG').wtp).toBe('EGP 121–180'); // modal for EG
  });
});

describe('market_entry — a stray off-target persona is not its own market (run a39ce46e)', () => {
  const questions = [
    { id: 'qs', kind: 'screener', isScreening: true },
    { id: 'qa', kind: 'appeal', type: 'rating' },
    { id: 'qi', kind: 'intent' },
  ];
  const r = (pid, country) => ([
    { persona_id: pid, persona_profile: { country }, question_id: 'qi', answer: 'Definitely would buy' },
    { persona_id: pid, persona_profile: { country }, question_id: 'qa', answer: 6 },
  ]);
  test('an n=1 AE persona in an SA+EG study is dropped, not surfaced as AE(n=1)', () => {
    const rows = [];
    for (let i = 0; i < 8; i += 1) rows.push(...r(`sa${i}`, 'SA'));
    for (let i = 0; i < 7; i += 1) rows.push(...r(`eg${i}`, 'EG'));
    rows.push(...r('ae1', 'AE')); // the stray
    const names = computeMarketEntry(rows, questions, { targeting: { geography: { countries: ['SA', 'EG'] } } })
      .markets.map((m) => m.market);
    expect(names).toEqual(expect.arrayContaining(['SA', 'EG']));
    expect(names).not.toContain('AE');
  });
});
