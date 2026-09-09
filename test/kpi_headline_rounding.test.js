/**
 * The KPI tiles carry the three largest numerals on the results page, and the
 * same strings go into the PDF, PPT and XLS exports.
 *
 * The narrator is told to copy them verbatim from the computed figures. When it
 * does not, it divides two counts itself and returns the raw float. Three of
 * the twenty-five most recent narrated missions in production carried one:
 *
 *   10ecb820  "Desert Fuel Purchase Intent (Top-2-Box)"  93.3333%
 *   5a07eaf8  "Convenience of home delivery"             74.4186%
 *   5a07eaf8  "Understated pragmatists citing..."        94.1176%
 *
 * 93.3333% is 14 of 15 respondents. Four decimal places is not precision, it is
 * false precision rendered at 48px.
 *
 * These cases are transcribed from the production rows above plus the shapes
 * that must NOT be touched - ratings out of 5, currency, counts, and figures
 * already written to two decimals.
 */
const { roundHeadlineFigures } = require('../src/services/ai/insights');

const valueOf = (v) => roundHeadlineFigures([{ label: 'x', value: v, trend: 'positive' }])[0].value;

describe('roundHeadlineFigures', () => {
  test.each([
    // the three real production values
    ['93.3333%', '93.3%'],
    ['74.4186%', '74.4%'],
    ['94.1176%', '94.1%'],
    // rounding, not truncation
    ['99.9999%', '100%'],
    ['12.3456 / 5', '12.3 / 5'],
    // more than one figure in a sentence
    ['exposed 7 vs control 4.5000 (+2.5000, significant)', 'exposed 7 vs control 4.5 (+2.5, significant)'],
  ])('%s -> %s', (input, expected) => {
    expect(valueOf(input)).toBe(expected);
  });

  test.each([
    ['72%'],                    // integer percentage
    ['4.2 / 5'],                // rating, one decimal
    ['3.55 / 5'],               // rating, two decimals - already how a person writes it
    ['$2,400,000'],             // currency with separators
    ['0 / 2 respondents'],      // counts
    ['100% win rate'],          // integer with a suffix
    ['NPS -20'],                // negative integer
  ])('leaves %s alone', (input) => {
    expect(valueOf(input)).toBe(input);
  });

  test('an untouched KPI is returned by identity, not rebuilt', () => {
    const kpi = { label: 'Interest', value: '72%', trend: 'positive' };
    expect(roundHeadlineFigures([kpi])[0]).toBe(kpi);
  });

  test('a rounded KPI keeps its label and trend', () => {
    const [out] = roundHeadlineFigures([{ label: 'Purchase Intent', value: '93.3333%', trend: 'positive' }]);
    expect(out).toEqual({ label: 'Purchase Intent', value: '93.3%', trend: 'positive' });
  });

  test('non-array and malformed input pass through rather than throwing', () => {
    expect(roundHeadlineFigures(null)).toBeNull();
    expect(roundHeadlineFigures(undefined)).toBeUndefined();
    expect(roundHeadlineFigures([null, { label: 'a' }, { value: 5 }]))
      .toEqual([null, { label: 'a' }, { value: 5 }]);
  });

  test('is idempotent', () => {
    const once = valueOf('93.3333%');
    expect(valueOf(once)).toBe(once);
  });
});
