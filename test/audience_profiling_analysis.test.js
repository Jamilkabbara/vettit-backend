/* WO §3.2 — audience_profiling segmentation: deterministic clustering + n-gate. */
const { computeAudienceProfiling, ATTITUDE_DIMENSIONS } = require('../src/services/analysis/audienceProfiling');

// One attitudinal question per dimension + one behavioural + one media + one needs.
const QUESTIONS = [
  { id: 'q_screen', kind: 'screener', type: 'single', text: 'Do you buy in this category?' },
  ...ATTITUDE_DIMENSIONS.map((d, i) => ({ id: `q_att_${i}`, kind: 'attitudinal', dimension: d, type: 'rating', text: `Attitude ${d}` })),
  { id: 'q_beh', kind: 'behavioural', type: 'single', text: 'How often do you buy?' },
  { id: 'q_media', kind: 'media', type: 'multi', text: 'Where do you spend media time?' },
  { id: 'q_needs', kind: 'needs', type: 'multi', text: 'What matters most?' },
];

// Build N personas in `groups` well-separated attitude clusters (deterministic).
function buildRows(groups) {
  const rows = [];
  let pid = 0;
  groups.forEach((g, gi) => {
    for (let i = 0; i < g.count; i += 1) {
      const persona_id = `p_${gi}_${i}`;
      pid += 1;
      ATTITUDE_DIMENSIONS.forEach((d, di) => {
        rows.push({ persona_id, question_id: `q_att_${di}`, answer: g.attitudes[d] });
      });
      rows.push({ persona_id, question_id: 'q_screen', answer: 'Yes' });
      rows.push({ persona_id, question_id: 'q_beh', answer: g.behaviour });
      rows.push({ persona_id, question_id: 'q_media', answer: g.media });
      rows.push({ persona_id, question_id: 'q_needs', answer: g.needs });
    }
  });
  return rows;
}

describe('computeAudienceProfiling', () => {
  test('n≥50 with separated groups → segmented, sizes sum ~100, primary flagged', () => {
    const rows = buildRows([
      { count: 30, attitudes: { price_sensitivity: 7, novelty_seeking: 2, brand_loyalty: 6, convenience: 6, status: 2, sustainability: 6 }, behaviour: 'Weekly', media: 'TV', needs: 'Price' },
      { count: 30, attitudes: { price_sensitivity: 2, novelty_seeking: 6, brand_loyalty: 3, convenience: 4, status: 7, sustainability: 3 }, behaviour: 'Daily', media: 'Instagram', needs: 'Status' },
    ]);
    const res = computeAudienceProfiling(rows, QUESTIONS, { goal_type: 'audience_profiling' });
    expect(res.methodology).toBe('audience_profiling');
    expect(res.posture).toBe('segmented');
    expect(res.n).toBe(60);
    expect(res.segments.length).toBeGreaterThanOrEqual(2);
    expect(res.segments.length).toBeLessThanOrEqual(4);
    const sizeSum = res.segments.reduce((s, x) => s + x.size_pct, 0);
    expect(Math.round(sizeSum)).toBe(100);
    expect(res.segments.filter((s) => s.is_primary).length).toBe(1);
    expect(res.primary_segment_id).toBe(res.segments[0].id);
    // every segment carries a profile + signature + coords + a non-empty name
    for (const s of res.segments) {
      expect(typeof s.name).toBe('string');
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.signature.length).toBeGreaterThan(0);
      expect(s.coords).toHaveProperty('x');
      expect(s.attitudes).toHaveProperty('price_sensitivity');
    }
  });

  test('n<50 → aggregate only, segments null, honest reason', () => {
    const rows = buildRows([
      { count: 10, attitudes: { price_sensitivity: 5, novelty_seeking: 5, brand_loyalty: 5, convenience: 5, status: 5, sustainability: 5 }, behaviour: 'Weekly', media: 'TV', needs: 'Price' },
    ]);
    const res = computeAudienceProfiling(rows, QUESTIONS, { goal_type: 'audience_profiling' });
    expect(res.posture).toBe('aggregate');
    expect(res.segments).toBeNull();
    expect(res.aggregate.attitudes.price_sensitivity.mean).toBeCloseTo(5, 1);
    expect(res.reason).toMatch(/too small|aggregate/i);
  });

  test('never throws on empty input', () => {
    const res = computeAudienceProfiling([], QUESTIONS, {});
    expect(res.methodology).toBe('audience_profiling');
    expect(res.posture).toBe('aggregate');
    expect(res.segments).toBeNull();
  });
});
