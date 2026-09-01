/**
 * Pass 49 — pin the model price table.
 *
 * MODEL_PRICING is not decorative. Every ai_calls.cost_usd row is computed
 * from it, missions.ai_spend_usd_actual is the running sum of those, and the
 * recruit loop reads THAT against ai_spend_ceiling_usd to decide when to stop
 * recruiting. A stale entry mis-states margin reporting AND moves a live
 * spend gate, silently, with no test failing.
 *
 * Two entries WERE stale until 2026-09-01:
 *   haiku-4-5    0.80 / 4.00   understated every Haiku row by 20%
 *   opus-4-7    15.00 / 75.00  overstated by 3x (never exercised: 0 rows)
 *
 * This suite exists so the next drift is a red test rather than a quiet
 * accounting error. If Anthropic changes a price, update BOTH this file and
 * the dated comment in anthropic.js - the failure is the reminder.
 */

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { MODEL_PRICING, MODEL_ROUTING } = require('../src/services/ai/anthropic');

const EXPECTED = {
  'claude-haiku-4-5':  { input: 1.00, output: 5.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-opus-4-7':   { input: 5.00, output: 25.00 },
};

test('the price table matches Anthropic list pricing as of 2026-09-01', () => {
  expect(MODEL_PRICING).toEqual(EXPECTED);
});

test('haiku is 1.00/5.00 — the value that was understated by 20%', () => {
  expect(MODEL_PRICING['claude-haiku-4-5'].input).toBe(1.00);
  expect(MODEL_PRICING['claude-haiku-4-5'].output).toBe(5.00);
});

test('opus is 5.00/25.00 — it was overstated 3x', () => {
  expect(MODEL_PRICING['claude-opus-4-7'].input).toBe(5.00);
  expect(MODEL_PRICING['claude-opus-4-7'].output).toBe(25.00);
});

test('EVERY routed model has a price — an unpriced model costs $0 silently', () => {
  const routed = new Set(Object.values(MODEL_ROUTING));
  const priced = new Set(Object.keys(MODEL_PRICING));
  const unpriced = [...routed].filter((m) => !priced.has(m));
  expect(unpriced).toEqual([]);
});

test('no price is zero or negative', () => {
  for (const [model, p] of Object.entries(MODEL_PRICING)) {
    expect(p.input).toBeGreaterThan(0);
    expect(p.output).toBeGreaterThan(0);
    // Output is dearer than input for every Anthropic model; a table where
    // that inverts is almost certainly a transposed edit.
    expect(p.output).toBeGreaterThan(p.input);
  }
});
