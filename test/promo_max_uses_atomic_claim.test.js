/**
 * max_uses is a limit, not a decoration.
 *
 * THE DEFECT
 * promo_codes.max_uses was never enforced. The only writer of uses_count was a
 * read-modify-write in src/routes/payments.js with the read in the application
 * and the write un-awaited:
 *
 *   .update({ uses_count: (promo.uses_count || 0) + 1 }).eq('code', promo.code)
 *     .then(() => {}).catch(() => {})
 *
 * Two checkouts landing together both read the same count and both took "the
 * last use", so a 25-use code gave out 26. VETTPROOF showed it in production.
 *
 * WHAT MUST HOLD NOW
 *   1. The use after the last one is refused.
 *   2. Two claims racing one remaining use produce exactly one winner - and
 *      the loser is TOLD it lost, rather than proceeding.
 *   3. max_uses NULL (and 0) is still unlimited.
 *   4. A retry does not spend a second use when the pass-53 ledger is there.
 *   5. The paid paths spend nothing at all while that ledger is absent, rather
 *      than double-counting across the webhook and the success-page poll.
 *
 * MUTATION CHECK: recorded in the PR body. Making the claim's UPDATE
 * unconditional fails the race test; removing the read-side refusal degrades
 * the (max+1) refusal to "contended" and fails that test; treating a NULL
 * max_uses as a limit fails the unlimited tests; letting the paid paths fall
 * back without the ledger fails the double-count test; and dropping the
 * redemption call out of the Stripe confirmation fails the last block.
 */
const {
  claimPromoUse,
  releasePromoUse,
  recordFreeLaunchRedemption,
  recordPaidRedemption,
  resolveUsablePromo,
  isPromoUsable,
} = require('../src/services/promo/promoCodes');
const { makePromoDb, makeGate } = require('./promoDbDouble');

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
const mockUpdateMission = jest.fn(async () => ({}));
jest.mock('../src/db/missionSchema', () => ({
  updateMission: mockUpdateMission,
  sanitizeMissionPatch: (patch) => ({ patch, rejected: [] }),
}));
const { confirmCheckoutSessionPaid } = require('../src/services/payments/confirmCheckoutSession');

const LIMITED   = { code: 'VETTPROOF', type: 'free', active: true, max_uses: 3, uses_count: 0, expires_at: null };
const UNLIMITED = { code: 'LAUNCH50', type: 'percentage', value: 50, active: true, max_uses: null, uses_count: 0, expires_at: null };

// Both claim paths have to obey the same contract: the one running today
// (conditional UPDATE over PostgREST) and the one pass-53 turns on (the
// database function). Every rule below is asserted against both.
const PATHS = [
  ['conditional UPDATE (pass-53 not applied)', false],
  ['claim_promo_code (pass-53 applied)',       true],
];

describe.each(PATHS)('%s', (_label, rpcDeployed) => {
  test('the use after the last one is refused', async () => {
    const db = makePromoDb([LIMITED], { rpcDeployed });

    const results = [];
    for (let i = 1; i <= 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await claimPromoUse(db, { code: 'VETTPROOF', missionId: `m${i}` }));
    }

    expect(results.map((r) => r.claimed)).toEqual([true, true, true, false]);
    expect(results[3].reason).toBe('exhausted');
    expect(db.row('VETTPROOF').uses_count).toBe(3);   // never 4
  });

  test('two claims racing the last use produce exactly one winner', async () => {
    // One use left, and both callers read the count before either writes -
    // which is precisely the interleaving the old code lost on.
    const gate = makeGate(2);
    const db = makePromoDb(
      [{ ...LIMITED, max_uses: 3, uses_count: 2 }],
      { rpcDeployed, onRead: gate },
    );

    const [a, b] = await Promise.all([
      claimPromoUse(db, { code: 'VETTPROOF', missionId: 'm-a' }),
      claimPromoUse(db, { code: 'VETTPROOF', missionId: 'm-b' }),
    ]);

    const winners = [a, b].filter((r) => r.claimed);
    expect(winners).toHaveLength(1);
    expect(db.row('VETTPROOF').uses_count).toBe(3);
    // The loser is refused, not silently allowed through.
    const loser = [a, b].find((r) => !r.claimed);
    expect(['exhausted', 'contended']).toContain(loser.reason);
  });

  test('a code with max_uses NULL is unlimited', async () => {
    const db = makePromoDb([UNLIMITED], { rpcDeployed });
    for (let i = 0; i < 40; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await claimPromoUse(db, { code: 'LAUNCH50', missionId: `m${i}` });
      expect(r.claimed).toBe(true);
    }
    expect(db.row('LAUNCH50').uses_count).toBe(40);
  });

  test('max_uses 0 is unlimited too, which is what the routes always meant', async () => {
    const db = makePromoDb([{ ...UNLIMITED, code: 'ZEROMAX', max_uses: 0 }], { rpcDeployed });
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await claimPromoUse(db, { code: 'ZEROMAX', missionId: `m${i}` })).claimed).toBe(true);
    }
    expect(db.row('ZEROMAX').uses_count).toBe(5);
  });

  test('an expired code is refused even with uses left', async () => {
    const db = makePromoDb([{ ...LIMITED, code: 'OLD', expires_at: '2020-01-01T00:00:00Z' }], { rpcDeployed });
    const r = await claimPromoUse(db, { code: 'OLD', missionId: 'm1' });
    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('expired');
    expect(db.row('OLD').uses_count).toBe(0);
  });

  test('a released claim gives the use back', async () => {
    const db = makePromoDb([LIMITED], { rpcDeployed });
    await claimPromoUse(db, { code: 'VETTPROOF', missionId: 'm1' });
    expect(db.row('VETTPROOF').uses_count).toBe(1);
    await releasePromoUse(db, { code: 'VETTPROOF', missionId: 'm1' });
    expect(db.row('VETTPROOF').uses_count).toBe(0);
  });

  test('the code is matched case and whitespace insensitively, as the routes send it', async () => {
    const db = makePromoDb([LIMITED], { rpcDeployed });
    const r = await claimPromoUse(db, { code: '  vettproof ', missionId: 'm1' });
    expect(r.claimed).toBe(true);
    expect(db.row('VETTPROOF').uses_count).toBe(1);
  });
});

describe('the pass-53 ledger is what makes a redemption idempotent', () => {
  test('applied: redeeming twice for the SAME mission spends one use', async () => {
    const db = makePromoDb([LIMITED], { rpcDeployed: true });
    const first  = await claimPromoUse(db, { code: 'VETTPROOF', missionId: 'm1' });
    const second = await claimPromoUse(db, { code: 'VETTPROOF', missionId: 'm1' });
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(true);
    expect(second.reason).toBe('already_redeemed');
    expect(db.row('VETTPROOF').uses_count).toBe(1);
  });

  test('applied: the webhook and the success-page poll confirming the same mission spend one use', async () => {
    const db = makePromoDb([LIMITED], { rpcDeployed: true });
    await Promise.all([
      recordPaidRedemption(db, { code: 'VETTPROOF', missionId: 'm1', source: 'stripe_webhook' }),
      recordPaidRedemption(db, { code: 'VETTPROOF', missionId: 'm1', source: 'checkout_session_poll' }),
    ]);
    expect(db.row('VETTPROOF').uses_count).toBe(1);
  });

  test('not applied: the paid paths record NOTHING rather than double-count', async () => {
    const db = makePromoDb([LIMITED], { rpcDeployed: false });
    const r = await recordPaidRedemption(db, { code: 'VETTPROOF', missionId: 'm1', source: 'stripe_webhook' });
    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('ledger_unavailable');
    expect(db.row('VETTPROOF').uses_count).toBe(0);
    expect(db.calls.updates).toBe(0);
  });

  test('not applied: the free-launch path still enforces the limit', async () => {
    const db = makePromoDb([{ ...LIMITED, max_uses: 1 }], { rpcDeployed: false });
    expect((await recordFreeLaunchRedemption(db, { code: 'VETTPROOF', missionId: 'm1' })).claimed).toBe(true);
    expect((await recordFreeLaunchRedemption(db, { code: 'VETTPROOF', missionId: 'm2' })).claimed).toBe(false);
    expect(db.row('VETTPROOF').uses_count).toBe(1);
  });

  test('a claim never throws at a paying customer', async () => {
    const broken = {
      rpc: async () => { throw new Error('network down'); },
      from: () => { throw new Error('network down'); },
    };
    const r = await recordPaidRedemption(broken, { code: 'VETTPROOF', missionId: 'm1' });
    expect(r.claimed).toBe(false);
  });
});

describe('one authority for "may this code be used"', () => {
  test('resolveUsablePromo hands back nothing once the code is out of uses', async () => {
    const db = makePromoDb([{ ...LIMITED, max_uses: 2, uses_count: 2 }]);
    expect(await resolveUsablePromo(db, 'VETTPROOF')).toBeNull();
  });

  test('resolveUsablePromo hands back the row while uses remain', async () => {
    const db = makePromoDb([{ ...LIMITED, max_uses: 2, uses_count: 1 }]);
    const row = await resolveUsablePromo(db, 'vettproof');
    expect(row && row.code).toBe('VETTPROOF');
  });

  test('the predicate reads the three ways a code dies, and nothing else', () => {
    expect(isPromoUsable({ active: true, max_uses: null, uses_count: 9999 })).toBe(true);
    expect(isPromoUsable({ active: true, max_uses: 5, uses_count: 4 })).toBe(true);
    expect(isPromoUsable({ active: true, max_uses: 5, uses_count: 5 })).toBe(false);
    expect(isPromoUsable({ active: false, max_uses: 5, uses_count: 0 })).toBe(false);
    expect(isPromoUsable({ active: true, expires_at: '2020-01-01T00:00:00Z' })).toBe(false);
    expect(isPromoUsable(null)).toBe(false);
  });
});

describe('no route may go back to doing the increment by hand', () => {
  const { readFileSync } = require('node:fs');
  const FILES = [
    '../src/routes/payments.js',
    '../src/routes/pricing.js',
    '../src/routes/missions.js',
    '../src/routes/webhooks.js',
    '../src/routes/admin.js',
    '../src/services/payments/confirmCheckoutSession.js',
    '../src/services/payments/paymentCoversRun.js',
    '../src/jobs/missionRecovery.js',
  ];

  test.each(FILES)('%s does not write uses_count itself', (rel) => {
    const src = readFileSync(require.resolve(rel), 'utf8');
    const code = src.split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n');
    // The whole defect in one pattern: uses_count set from a value the
    // application computed. Only src/services/promo/promoCodes.js may do that,
    // and only inside a conditional statement.
    expect(code).not.toMatch(/uses_count\s*:/);
  });
});

describe('the Stripe path counts a redemption at payment confirmation', () => {
  // A percentage or flat code redeemed through Stripe was never counted
  // anywhere, so max_uses did nothing for it at all. It is counted when the
  // payment is confirmed - not when the Session is opened, because an
  // abandoned checkout must not spend somebody's use.
  const session = {
    id: 'cs_1', status: 'complete', payment_status: 'paid',
    payment_intent: 'pi_1', amount_total: 4900, metadata: { missionId: 'm1' },
  };

  const hybrid = (promoDb, missionRow) => {
    const missionChain = () => {
      const resolved = () => ({ data: missionRow, error: missionRow ? null : { message: 'not found' } });
      const chain = {
        select: () => chain, eq: () => chain, insert: () => chain, update: () => chain,
        single: async () => resolved(),
        maybeSingle: async () => resolved(),
        then: (onF, onR) => Promise.resolve(resolved()).then(onF, onR),
      };
      return chain;
    };
    return {
      from: (table) => (table === 'promo_codes' ? promoDb.from(table) : missionChain()),
      rpc: (...args) => promoDb.rpc(...args),
    };
  };

  const paidMission = (over = {}) => ({
    id: 'm1', status: 'draft', user_id: 'u1', promo_code: 'LAUNCH50', ...over,
  });

  test('applied: a confirmed Stripe payment spends one use of its code', async () => {
    const db = makePromoDb([{ ...UNLIMITED, max_uses: 10 }], { rpcDeployed: true });
    const runMission = jest.fn(async () => ({}));

    const res = await confirmCheckoutSessionPaid(
      { supabase: hybrid(db, paidMission()), runMission }, session,
    );

    expect(res.triggered).toBe(true);
    expect(db.row('LAUNCH50').uses_count).toBe(1);
  });

  test('applied: an abandoned checkout spends nothing', async () => {
    const db = makePromoDb([{ ...UNLIMITED, max_uses: 10 }], { rpcDeployed: true });
    const unpaid = { ...session, payment_status: 'unpaid' };

    const res = await confirmCheckoutSessionPaid(
      { supabase: hybrid(db, paidMission()), runMission: jest.fn(async () => ({})) }, unpaid,
    );

    expect(res.triggered).toBe(false);
    expect(db.row('LAUNCH50').uses_count).toBe(0);
  });

  test('applied: a code already at its limit does not withhold a mission that was paid for', async () => {
    // The customer has paid. Refusing them the study they bought would be the
    // wrong end of the problem, so this is logged loudly and allowed.
    const db = makePromoDb([{ ...UNLIMITED, max_uses: 1, uses_count: 1 }], { rpcDeployed: true });
    const runMission = jest.fn(async () => ({}));

    const res = await confirmCheckoutSessionPaid(
      { supabase: hybrid(db, paidMission()), runMission }, session,
    );

    expect(res.triggered).toBe(true);
    expect(db.row('LAUNCH50').uses_count).toBe(1);   // never 2
  });
});
