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
