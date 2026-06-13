/**
 * Pass 47 — narrator computed-fallback: when the LLM synthesis can't be
 * parsed, the executive summary is built from the deterministic analysis
 * object and NEVER the useless "contact support" string.
 */
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
const { buildComputedSummary } = require('../src/services/ai/insights');

test('null / no-methodology / no-n analysis → null (caller supplies a generic line)', () => {
  expect(buildComputedSummary(null, {})).toBeNull();
  expect(buildComputedSummary({}, {})).toBeNull(); // no methodology + no n → nothing computable
});

test('brand_lift summary cites exposed/control cells + biggest lift, never "contact support"', () => {
  const analysis = {
    methodology: 'brand_lift', n: 5,
    cells: { exposed: { n: 3 }, control: { n: 2 } },
    funnel: [
      { text: 'Purchase Intent', funnel_stage: 'intent', type: 'proportion', lift_abs: 0.14, significance: { sig95: true } },
      { text: 'Awareness', funnel_stage: 'awareness', type: 'proportion', lift_abs: 0.05, significance: { sig95: false, sig90: false } },
    ],
  };
  const s = buildComputedSummary(analysis, {});
  expect(s).toContain('exposed cell (n=3)');
  expect(s).toContain('control cell (n=2)');
  expect(s).toContain('Purchase Intent');
  expect(s).toContain('14 pts');
  expect(s).not.toMatch(/contact support/i);
});

test('pricing summary cites OPP + range', () => {
  const s = buildComputedSummary({
    methodology: 'pricing', n: 5,
    van_westendorp: { points: { opp: 95 } },
    acceptable_range: { low: 72, high: 110 },
    gabor_granger: { optimal_price: 79 },
  }, {});
  expect(s).toContain('95');
  expect(s).toContain('72');
  expect(s).toContain('79');
  expect(s).not.toMatch(/contact support/i);
});

test('satisfaction summary cites NPS + CSAT', () => {
  const s = buildComputedSummary({ methodology: 'satisfaction', n: 5, nps: { score: -20 }, csat: { top2_pct: 80 } }, {});
  expect(s).toContain('NPS is -20');
  expect(s).toContain('80%');
});

test('roadmap summary cites top MaxDiff feature + Kano must-haves', () => {
  const s = buildComputedSummary({
    methodology: 'roadmap', n: 5,
    maxdiff: { features: [{ label: 'Offline mode', feature_id: 'f1', utility: 1.0 }] },
    kano: { features: [{ label: 'Bill reminders', feature_id: 'f2', classification: 'must_be' }] },
  }, {});
  expect(s).toContain('Offline mode');
  expect(s).toContain('Bill reminders');
});

test('unknown methodology with n → generic non-error line', () => {
  const s = buildComputedSummary({ methodology: 'something_new', n: 7 }, {});
  expect(s).toContain('n=7');
  expect(s).not.toMatch(/contact support/i);
});
