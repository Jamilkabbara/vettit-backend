/* Pass 49 Phase 4 — response/segment filter engine. */
const { buildSegments, filterResponsesBySegment, personaSetForSegment, SEG_FLOOR } = require('../src/services/report/segments');

// 5 personas. q1 NPS (recommend, 0-10), q2 single-select satisfaction, q3 multi.
const mission = {
  goal_type: 'satisfaction',
  questions: [
    { id: 'q1', type: 'rating', text: 'How likely are you to recommend us?' },
    { id: 'q2', type: 'single', text: 'How satisfied are you?' },
    { id: 'q3', type: 'multi', text: 'Which issues did you hit?' },
    { id: 'q0', type: 'single', isScreening: true, text: 'Are you a customer?' },
  ],
};
const R = [];
const nps = { p1: 9, p2: 10, p3: 8, p4: 6, p5: 3 };            // 2 promoters, 1 passive, 2 detractors
const sat = { p1: 'Satisfied', p2: 'Satisfied', p3: 'Satisfied', p4: 'Unhappy', p5: 'Unhappy' };
const multi = { p1: ['Late'], p2: ['Late'], p3: ['Wrong item'], p4: ['Late', 'Wrong item'], p5: ['Late'] };
for (const p of ['p1', 'p2', 'p3', 'p4', 'p5']) {
  R.push({ persona_id: p, question_id: 'q1', answer: nps[p], persona_profile: { id: p } });
  R.push({ persona_id: p, question_id: 'q2', answer: sat[p], persona_profile: { id: p } });
  R.push({ persona_id: p, question_id: 'q3', answer: multi[p], persona_profile: { id: p } });
  R.push({ persona_id: p, question_id: 'q0', answer: 'Yes', persona_profile: { id: p } });
}

describe('buildSegments', () => {
  const segs = buildSegments(mission, R);
  test('offers NPS bands with correct n (detractor 2, promoter 2; passive 1 gated out)', () => {
    const byKey = Object.fromEntries(segs.map((s) => [s.key, s.n]));
    expect(byKey['nps:promoter']).toBe(2);
    expect(byKey['nps:detractor']).toBe(2);
    expect(byKey['nps:passive']).toBeUndefined(); // n=1 < SEG_FLOOR(2) → not offered
  });
  test('offers by-answer segments above the floor, never a whole-sample cut', () => {
    const sat = segs.find((s) => s.key === 'ans:q2:Satisfied');
    expect(sat).toBeTruthy(); expect(sat.n).toBe(3);
    // "Late" multi value selected by 4/5 → offered (n=4 < total 5)
    expect(segs.find((s) => s.key === 'ans:q3:Late')?.n).toBe(4);
  });
  test('never offers segments from a screener question', () => {
    expect(segs.some((s) => s.key.startsWith('ans:q0:'))).toBe(false);
  });
  test('SEG_FLOOR floor applies', () => {
    expect(SEG_FLOOR).toBeGreaterThanOrEqual(2);
  });
});

describe('personaSetForSegment / filter', () => {
  test('nps:promoter resolves the two promoters', () => {
    const set = personaSetForSegment(mission, R, 'nps:promoter');
    expect([...set].sort()).toEqual(['p1', 'p2']);
  });
  test('ans:q2:Unhappy resolves the two unhappy respondents', () => {
    const set = personaSetForSegment(mission, R, 'ans:q2:Unhappy');
    expect([...set].sort()).toEqual(['p4', 'p5']);
  });
  test('multi ans:q3:Wrong item matches anyone who selected it', () => {
    const set = personaSetForSegment(mission, R, 'ans:q3:Wrong item');
    expect([...set].sort()).toEqual(['p3', 'p4']);
  });
  test('filterResponsesBySegment keeps only the subset rows', () => {
    const subset = filterResponsesBySegment(mission, R, 'nps:detractor');
    const personas = new Set(subset.map((r) => r.persona_id));
    expect([...personas].sort()).toEqual(['p4', 'p5']);
    expect(subset.every((r) => personas.has(r.persona_id))).toBe(true);
  });
  test('unknown key → null (route returns 400)', () => {
    expect(filterResponsesBySegment(mission, R, 'bogus:x')).toBeNull();
  });
});

// D7 — segments are attached to the report AFTER buildCanonicalReport's no-dash
// scrub, so the segment builder must itself emit dash-free keys + labels (price
// bands like "SAR 31–40" are the carriers) while STILL resolving to respondents.
describe('buildSegments — D7 no em/en dashes', () => {
  const priceMission = {
    goal_type: 'market_entry',
    questions: [{ id: 'q1', type: 'single', text: 'Acceptable price per meal?' }],
  };
  const PR = [];
  // 4 personas: 2 picked the en-dash band, 2 picked the em-dash band.
  const ans = { a: 'SAR 31–40 per meal', b: 'SAR 31–40 per meal', c: 'Premium — over SAR 60', d: 'Premium — over SAR 60' };
  for (const p of ['a', 'b', 'c', 'd']) PR.push({ persona_id: p, question_id: 'q1', answer: ans[p], persona_profile: { id: p } });
  const segs = buildSegments(priceMission, PR);

  test('no segment key or label contains an em/en dash', () => {
    expect(segs.length).toBeGreaterThan(0);
    for (const seg of segs) {
      expect(seg.key).not.toMatch(/[—–]/);
      expect(seg.label).not.toMatch(/[—–]/);
    }
  });
  test('en-dash price band scrubs to a hyphen and still resolves to its 2 respondents', () => {
    const seg = segs.find((s) => s.key === 'ans:q1:SAR 31-40 per meal');
    expect(seg).toBeTruthy();
    expect(seg.n).toBe(2);
    const subset = filterResponsesBySegment(priceMission, PR, seg.key);
    expect(new Set(subset.map((r) => r.persona_id))).toEqual(new Set(['a', 'b']));
  });
  test('em-dash band scrubs to a comma and still resolves to its 2 respondents', () => {
    const seg = segs.find((s) => s.key === 'ans:q1:Premium, over SAR 60');
    expect(seg).toBeTruthy();
    const subset = filterResponsesBySegment(priceMission, PR, seg.key);
    expect(new Set(subset.map((r) => r.persona_id))).toEqual(new Set(['c', 'd']));
  });
});
