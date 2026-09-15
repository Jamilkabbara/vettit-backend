'use strict';
// Shapes are real: af36a36d was charged $9, Stripe refunded all $9, and the
// legacy partial_refund_amount_cents column says $3.60. 7f54fb42 never stored
// its PaymentIntent id; Stripe finds it only through metadata.missionId.
const { planRefundSync, syncMissionRefunds, readMissionStripeState } = require('../src/services/payments/syncMissionRefunds');

function fakeStripe({ pis, refunds, search = [] }) {
  return {
    paymentIntents: {
      retrieve: jest.fn(async (id) => {
        const pi = pis[id];
        if (!pi) throw new Error(`no such payment_intent ${id}`);
        return pi;
      }),
      search: jest.fn(async () => ({ data: search.map((id) => pis[id]) })),
    },
    refunds: { list: jest.fn(async ({ payment_intent }) => ({ data: refunds[payment_intent] || [] })) },
  };
}

function fakeSupabase(rows) {
  const db = new Map(rows.map((r) => [r.id, { ...r }]));
  const query = () => {
    const filters = [];
    const q = {
      select: () => q,
      eq: (col, val) => { filters.push([col, val]); return q; },
      maybeSingle: async () => ({ data: [...db.values()].find((r) => filters.every(([c, v]) => r[c] === v)) || null, error: null }),
    };
    return q;
  };
  return { db, from: () => query() };
}

const updateMission = jest.fn(async (supabase, id, patch) => {
  Object.assign(supabase.db.get(id), patch);
  return { error: null };
});

const PI = 'pi_af36';
const charged = (id, cents, refundedCents, metadata = {}) => ({
  id, status: 'succeeded', amount_received: cents, metadata,
  latest_charge: { id: `ch_${id}`, amount_refunded: refundedCents },
});

beforeEach(() => updateMission.mockClear());

test('the first delivery records the refund; the second changes nothing', async () => {
  const supabase = fakeSupabase([{ id: 'af36a36d', paid_at: '2026-04-27', latest_payment_intent_id: PI, refunded_amount_cents: 0, stripe_refund_ids: [], partial_refund_amount_cents: 360 }]);
  const stripe = fakeStripe({ pis: { [PI]: charged(PI, 900, 900) }, refunds: { [PI]: [{ id: 're_1', amount: 900, status: 'succeeded' }] } });

  const first = await syncMissionRefunds({ stripe, supabase, updateMission, paymentIntentId: PI });
  expect(first).toMatchObject({ matched: true, written: true });
  expect(supabase.db.get('af36a36d')).toMatchObject({ refunded_amount_cents: 900, stripe_refund_ids: ['re_1'] });
  expect(first.plan).toMatchObject({ capturedCents: 900, netCents: 0, legacyPartialRefundCents: 360 });

  const second = await syncMissionRefunds({ stripe, supabase, updateMission, paymentIntentId: PI });
  expect(second).toMatchObject({ matched: true, written: false });
  expect(updateMission).toHaveBeenCalledTimes(1);
});

test('a canceled refund is un-recorded, because Stripe is read, not the event', async () => {
  const supabase = fakeSupabase([{ id: 'm1', paid_at: 'x', latest_payment_intent_id: PI, refunded_amount_cents: 900, stripe_refund_ids: ['re_1'] }]);
  const stripe = fakeStripe({ pis: { [PI]: charged(PI, 900, 0) }, refunds: { [PI]: [{ id: 're_1', amount: 900, status: 'canceled' }] } });
  const r = await syncMissionRefunds({ stripe, supabase, updateMission, paymentIntentId: PI });
  expect(r.written).toBe(true);
  expect(supabase.db.get('m1')).toMatchObject({ refunded_amount_cents: 0, stripe_refund_ids: [] });
});

test('a mission charged without a stored PaymentIntent is found by its metadata', async () => {
  const pi = 'pi_7f54';
  const supabase = fakeSupabase([{ id: '7f54fb42', paid_at: '2026-04-21', latest_payment_intent_id: null, refunded_amount_cents: 0, stripe_refund_ids: [] }]);
  const stripe = fakeStripe({ pis: { [pi]: charged(pi, 900, 900, { missionId: '7f54fb42' }) }, refunds: { [pi]: [{ id: 're_7', amount: 900, status: 'succeeded' }] }, search: [pi] });
  const r = await syncMissionRefunds({ stripe, supabase, updateMission, paymentIntentId: pi });
  expect(r).toMatchObject({ matched: true, written: true });
  expect(supabase.db.get('7f54fb42').refunded_amount_cents).toBe(900);
});

test('every succeeded payment for a mission is summed', async () => {
  const stripe = fakeStripe({
    pis: { pi_a: charged('pi_a', 900, 900), pi_b: charged('pi_b', 1900, 0), pi_c: { id: 'pi_c', status: 'canceled', amount_received: 0, latest_charge: null } },
    refunds: { pi_a: [{ id: 're_a', amount: 900, status: 'succeeded' }] },
    search: ['pi_b', 'pi_c'],
  });
  const state = await readMissionStripeState(stripe, { id: 'm', latest_payment_intent_id: 'pi_a' });
  expect(state).toMatchObject({ paymentIntentIds: ['pi_a', 'pi_b'], capturedCents: 2800, refundedCents: 900, refundIds: ['re_a'] });
});

test('a payment with no mission (a chat pack, a payment link) is reported, not written', async () => {
  const stripe = fakeStripe({ pis: { pi_x: charged('pi_x', 500, 500) }, refunds: {} });
  const r = await syncMissionRefunds({ stripe, supabase: fakeSupabase([]), updateMission, paymentIntentId: 'pi_x' });
  expect(r).toEqual({ matched: false, paymentIntentId: 'pi_x' });
  expect(updateMission).not.toHaveBeenCalled();
});

test('a Stripe failure throws, so the webhook returns 500 and Stripe retries', async () => {
  const supabase = fakeSupabase([{ id: 'm1', paid_at: 'x', latest_payment_intent_id: 'pi_gone', refunded_amount_cents: 0, stripe_refund_ids: [] }]);
  const stripe = fakeStripe({ pis: {}, refunds: {} });
  await expect(syncMissionRefunds({ stripe, supabase, updateMission, paymentIntentId: 'pi_gone' })).rejects.toThrow('no such payment_intent');
  expect(updateMission).not.toHaveBeenCalled();
});

test('planRefundSync: dry run and real run see the same plan', () => {
  const mission = { id: 'm', refunded_amount_cents: 0, stripe_refund_ids: [] };
  const state = { chargeIds: ['ch'], capturedCents: 900, refundedCents: 900, refundIds: ['re_1'] };
  const a = planRefundSync(mission, state);
  const b = planRefundSync(mission, state);
  expect({ ...a, patch: { ...a.patch, refunds_synced_at: 0 } }).toEqual({ ...b, patch: { ...b.patch, refunds_synced_at: 0 } });
  expect(planRefundSync({ ...mission, refunded_amount_cents: 900, stripe_refund_ids: ['re_1'] }, state).changed).toBe(false);
});

test('refund columns are server-owned: no customer request can write them', () => {
  const schema = require('../src/db/missionSchema');
  for (const col of ['refunded_amount_cents', 'stripe_refund_ids', 'refunds_synced_at']) {
    expect(schema.SERVER_OWNED_COLUMNS.has ? schema.SERVER_OWNED_COLUMNS.has(col) : schema.SERVER_OWNED_COLUMNS.includes(col)).toBe(true);
    expect([...schema.CLIENT_PATCHABLE_COLUMNS]).not.toContain(col);
    expect([...schema.ALLOWED_COLUMNS]).toContain(col);
  }
});
