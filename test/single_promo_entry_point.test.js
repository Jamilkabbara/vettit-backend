/**
 * One promo entry point, one price authority.
 *
 * Promo entry used to exist in two places with two authorities. Ours resolves
 * the code against promo_codes and re-prices server-side, baking the result
 * into the Checkout Session's unit_amount. Stripe's own box applies its own
 * coupon objects on top of a line item we have ALREADY discounted, so the same
 * code could be applied twice, once on each side.
 *
 * Four codes carry live Stripe coupon and promotion-code objects (FRIEND10,
 * LAUNCH50, VETT20, PASS44TEST). Turning this flag off is what makes them
 * unreachable; it does not delete them.
 *
 * Note the flag was NOT the reason Creative Attention showed no promo box.
 * There is exactly one createCheckoutSession call on the payments path and CA
 * uses it, so the flag was set for CA too. CA's real gap was in the app: it
 * sent no promoCode at all and had no branch for a 100%-off result.
 */
const { readFileSync } = require('node:fs');
const SRC = readFileSync(require.resolve('../src/services/stripe'), 'utf8');

describe('Stripe-side promo entry is closed', () => {
  test('allow_promotion_codes is false', () => {
    expect(SRC).toMatch(/allow_promotion_codes:\s*false/);
    expect(SRC).not.toMatch(/allow_promotion_codes:\s*true/);
  });

  test('there is exactly one place the flag is set', () => {
    const hits = SRC.match(/allow_promotion_codes\s*:/g) || [];
    expect(hits).toHaveLength(1);
  });

  test('no discounts array is passed, so nothing can stack on the baked price', () => {
    // The discount is already inside unit_amount. A discounts[] entry would
    // apply a second reduction to an already-reduced line item.
    expect(SRC).not.toMatch(/discounts\s*:\s*\[/);
  });
});
