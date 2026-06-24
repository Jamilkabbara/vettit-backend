/* §8 — deterministic "who responded" personas. The grouping, shares, n-gating
 * and singleton-folding are pure functions of the respondent profiles, so they
 * are fully unit-testable (no LLM). (Persona PROSE enrichment, if added later,
 * is the only part that needs real-run verification.) */
const { computePersonas } = require('../src/services/analysis/personas');

const prof = (over) => ({
  age: 30, occupation: 'Analyst', seniority: 'mid', industry: 'Tech',
  income_band: 'mid', decision_style: 'analytical', values: ['quality', 'speed'], ...over,
});
// One respondent = one or more rows (questions); dedupe is by persona_id.
const rows = (specs) => specs.flatMap(([id, p, screened], i) => [
  { persona_id: id, persona_profile: p, screened_out: !!screened },
  { persona_id: id, persona_profile: p, screened_out: !!screened }, // a 2nd row, same persona
]);

describe('computePersonas — grouping + shares', () => {
  test('groups by the best dimension with correct shares + n', () => {
    const r = rows([
      ['p1', prof({ decision_style: 'analytical' })], ['p2', prof({ decision_style: 'analytical' })],
      ['p3', prof({ decision_style: 'analytical' })], ['p4', prof({ decision_style: 'analytical' })],
      ['p5', prof({ decision_style: 'intuitive' })], ['p6', prof({ decision_style: 'intuitive' })],
    ]);
    const ps = computePersonas(r, {});
    expect(ps).toHaveLength(2);
    expect(ps[0]).toMatchObject({ name: 'Analytical Decision-Makers', share: '67%', n: 4 });
    expect(ps[1]).toMatchObject({ name: 'Intuitive Decision-Makers', share: '33%', n: 2 });
    expect(Object.keys(ps[0]).sort()).toEqual(['description', 'n', 'name', 'role', 'share']);
  });

  test('a single respondent is never its own persona (singleton folded/dropped)', () => {
    const r = rows([
      ['p1', prof({ decision_style: 'analytical' })], ['p2', prof({ decision_style: 'analytical' })], ['p3', prof({ decision_style: 'analytical' })], ['p4', prof({ decision_style: 'analytical' })], ['p5', prof({ decision_style: 'analytical' })],
      ['p6', prof({ decision_style: 'intuitive' })], ['p7', prof({ decision_style: 'intuitive' })], ['p8', prof({ decision_style: 'intuitive' })], ['p9', prof({ decision_style: 'intuitive' })], ['p10', prof({ decision_style: 'intuitive' })],
      ['p11', prof({ decision_style: 'cautious' })], // lone respondent
    ]);
    const ps = computePersonas(r, {});
    expect(ps).toHaveLength(2);
    expect(ps.map((p) => p.name)).not.toContain('Cautious Decision-Makers');
    expect(ps.every((p) => p.n >= 2)).toBe(true);
  });

  test('high-cardinality free-text dims are skipped; groups by the dominant dimension', () => {
    // Regression for the market_entry real-run (mission b8f5abce): real synthetic
    // profiles carry a UNIQUE free-text decision_style per respondent (50+ distinct)
    // + many distinct occupations, but seniority has dominant top values. The old
    // "reject >6 distinct values" rule returned [] on a clean n=80 run.
    const profs = [];
    const add = (sen, n) => { for (let i = 0; i < n; i += 1) { const k = profs.length; profs.push({ persona_id: `p${k}`, persona_profile: { seniority: sen, decision_style: `unique-style-phrase-${k}`, occupation: `occupation-${k}`, values: ['quality'], age: 30 } }); } };
    add('mid', 18); add('senior', 14); add('junior', 6); add('entry', 2); // 40 total
    const ps = computePersonas(profs, {});
    expect(ps.length).toBeGreaterThanOrEqual(3);
    expect(ps.map((p) => p.name)).toEqual(expect.arrayContaining([
      'Mid-Career Professionals', 'Senior Professionals', 'Early-Career Professionals',
    ]));
    // the 5% / n=2 'entry' tail is folded into "Other", never its own persona
    expect(ps.find((p) => p.name === 'Other Respondents')?.n).toBe(2);
    expect(ps.every((p) => p.n >= 2)).toBe(true);
  });

  test('dedupes by persona_id and excludes screened-out respondents', () => {
    const r = [
      { persona_id: 'p1', persona_profile: prof({ decision_style: 'analytical' }) },
      { persona_id: 'p1', persona_profile: prof({ decision_style: 'analytical' }) }, // dup → counts once
      { persona_id: 'p2', persona_profile: prof({ decision_style: 'analytical' }) },
      { persona_id: 'p3', persona_profile: prof({ decision_style: 'intuitive' }) },
      { persona_id: 'p4', persona_profile: prof({ decision_style: 'intuitive' }) },
      { persona_id: 'pX', persona_profile: prof({ decision_style: 'intuitive' }), screened_out: true }, // excluded
    ];
    const ps = computePersonas(r, {});
    const totalN = ps.reduce((s, p) => s + p.n, 0);
    expect(totalN).toBe(4); // p1..p4, screened pX excluded, dup p1 counted once
  });
});

describe('computePersonas — honest empty cases', () => {
  test('fewer than 3 respondents → []', () => {
    expect(computePersonas(rows([['p1', prof()], ['p2', prof()]]), {})).toEqual([]);
  });

  test('one dominant group (no real split) → [] (a single ~100% persona says nothing)', () => {
    const r = rows([['p1', prof()], ['p2', prof()], ['p3', prof()], ['p4', prof()]]); // all identical
    expect(computePersonas(r, {})).toEqual([]);
  });

  test('no profiles → []', () => {
    expect(computePersonas([{ persona_id: 'p1' }, { persona_id: 'p2' }], {})).toEqual([]);
    expect(computePersonas([], {})).toEqual([]);
    expect(computePersonas(null, {})).toEqual([]);
  });
});
