/* WO §D3/§D4 — server-side respondent tier + price authority. */
const { priceFor, snapN, splitFor, isControlCell, tiersFor } = require('../src/services/pricing/respondentTiers');

describe('single-cell pricing (most types)', () => {
  test('FINAL ladder prices', () => {
    expect(priceFor('pricing', 50).price).toBe(29);
    expect(priceFor('pricing', 100).price).toBe(49);
    expect(priceFor('pricing', 200).price).toBe(89);
    expect(priceFor('pricing', 300).price).toBe(119);
    expect(priceFor('pricing', 500).price).toBe(179);
    expect(priceFor('pricing', 1000).price).toBe(299);
    expect(priceFor('pricing', 25).price).toBe(9); // $9 quick pulse
  });
  test('recommended default is 300', () => {
    expect(tiersFor('validate').recommended).toBe(300);
    expect(tiersFor('validate').stops.find((s) => s.recommended).n).toBe(300);
  });
  test('arbitrary n snaps to nearest valid stop at/below', () => {
    expect(snapN('pricing', 275)).toBe(200);
    expect(snapN('pricing', 750)).toBe(500);
    expect(priceFor('pricing', 275).price).toBe(89);
  });
  test('single-cell has no split', () => {
    expect(priceFor('pricing', 300).split).toBeNull();
  });
});

describe('control-cell (lift) pricing', () => {
  test('brand_lift is a control-cell type; floor 200, recommended 500', () => {
    expect(isControlCell('brand_lift')).toBe(true);
    expect(tiersFor('brand_lift').floor).toBe(200);
    expect(tiersFor('brand_lift').recommended).toBe(500);
  });
  test('cannot go below 200 total; $9/50/100 disabled', () => {
    expect(priceFor('brand_lift', 50).n).toBe(200);
    expect(priceFor('brand_lift', 100).n).toBe(200);
    expect(priceFor('brand_lift', 25).n).toBe(200);
    const stops = tiersFor('brand_lift').stops.map((s) => s.n);
    expect(stops).not.toContain(50);
    expect(stops).not.toContain(100);
    expect(stops).not.toContain(25);
  });
  test('priced by total — lift 500 = $179 (same as a general 500) + 250/250 split', () => {
    const p = priceFor('brand_lift', 500);
    expect(p.price).toBe(179);
    expect(p.split).toEqual({ exposed: 250, control: 250 });
  });
  test('creative_attention is control-cell ONLY in lift mode', () => {
    expect(isControlCell('creative_attention')).toBe(false);
    expect(isControlCell('creative_attention', { liftMode: true })).toBe(true);
    expect(priceFor('creative_attention', 50, { liftMode: true }).n).toBe(200);
    expect(priceFor('creative_attention', 50).n).toBe(50); // default single-cell
  });
});

describe('enterprise + split', () => {
  test('above 1,000 → custom (no self-serve price)', () => {
    const p = priceFor('pricing', 2000);
    expect(p.enterprise).toBe(true);
    expect(p.price).toBeNull();
  });
  test('splitFor halves, exposed takes the odd one', () => {
    expect(splitFor(500)).toEqual({ exposed: 250, control: 250 });
    expect(splitFor(201)).toEqual({ exposed: 101, control: 100 });
  });
});
