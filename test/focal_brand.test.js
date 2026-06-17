/* WO §2.3 — focal-brand resolution never emits the "Our Brand" placeholder. */
const { deriveFocalBrand, isGeneric } = require('../src/utils/focalBrand');

describe('deriveFocalBrand', () => {
  test('uses the captured brand when present', () => {
    expect(deriveFocalBrand('Acme', 'whatever')).toBe('Acme');
  });

  test('never returns the "Our Brand" placeholder', () => {
    expect(deriveFocalBrand('Our Brand', '')).not.toBe('Our Brand');
    expect(deriveFocalBrand('our brand', '')).toBe('the brand');
    expect(deriveFocalBrand(null, '')).toBe('the brand');
    expect(deriveFocalBrand('', null)).toBe('the brand');
  });

  test('derives a quoted brand from the brief when unset', () => {
    expect(deriveFocalBrand(null, 'We are testing "Zephyr" against rivals')).toBe('Zephyr');
  });

  test('derives a "for X" brand from the brief', () => {
    expect(deriveFocalBrand('', 'Competitive study for Nimbus in the UAE')).toBe('Nimbus');
  });

  test('falls back to neutral when the brief has no clear brand', () => {
    expect(deriveFocalBrand(null, 'a study about the market')).toBe('the brand');
  });

  test('isGeneric flags placeholders', () => {
    expect(isGeneric('Our Brand')).toBe(true);
    expect(isGeneric('the company')).toBe(true);
    expect(isGeneric('Acme')).toBe(false);
  });
});
