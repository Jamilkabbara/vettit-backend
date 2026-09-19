'use strict';
/**
 * A payment must cover the mission as it NOW is. Fixture shapes follow the
 * 2026-09-18 case: a $9 session opened at 5 respondents, mission then at 1,250.
 */
process.env.NODE_ENV = 'test';
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const { guardPaymentCoversMission, expireSessions, expireSupersededSessions } = require('../src/services/payments/checkoutInvalidation');

function fakeSupabase(missionRow) {
  const db = { mission: missionRow ? { ...missionRow } : null, updates: [], alerts: [], notifications: [] };
  const from = (table) => {
    const q = {
      _filters: [],
      select: () => q, eq: () => q, neq: () => q,
      maybeSingle: async () => ({ data: table === 'missions' ? db.mission : null, error: null }),
      update: (patch) => ({ eq: async () => { db.updates.push(patch); Object.assign(db.mission || {}, patch); return { error: null }; } }),
      insert: (row) => {
        if (table === 'admin_alerts') db.alerts.push(row);
        if (table === 'notifications') db.notifications.push(row);
        return Promise.resolve({ error: null });
      },
      then: (r) => Promise.resolve({ data: db.mission ? [db.mission] : [], error: null }).then(r),
    };
    return q;
  };
  return { db, client: { from, auth: { admin: { getUserById: async () => ({ data: { user: { email: 'c@x.io', user_metadata: { full_name: 'Customer' } } } }) } } } };
}

const stripeFake = () => {
  const s = { refunds: [], expired: [], sessions: {} };
  s.api = {
    refunds: { create: jest.fn(async (args, opts) => { s.refunds.push({ args, opts }); return { id: 're_1' }; }) },
    checkout: { sessions: {
      retrieve: jest.fn(async (id) => { if (!s.sessions[id]) throw new Error('No such checkout.session'); return { id, status: s.sessions[id] }; }),
      expire: jest.fn(async (id) => { s.expired.push(id); s.sessions[id] = 'expired'; return { id, status: 'expired' }; }),
    } },
  };
  return s;
};

const mission = { id: 'm-1250', user_id: 'u1', status: 'draft', respondent_count: 1250, title: 'honey', rejected_payment_intent_ids: [] };
const pi = { id: 'pi_9', metadata: { missionId: 'm-1250' } };
const email = { sendPaymentRefundedMissionChangedEmail: jest.fn(async () => ({})) };

beforeEach(() => email.sendPaymentRefundedMissionChangedEmail.mockClear());

test('a payment that does not cover the mission as it now is gets refunded, recorded, and never accepted', async () => {
  const { db, client } = fakeSupabase(mission);
  const stripe = stripeFake();
  const check = jest.fn(async () => ({ ok: false, unverifiable: false, capturedCents: 900, owedCents: 109900 }));
  const r = await guardPaymentCoversMission({ stripe: stripe.api, supabase: client, pi, checkPaymentCoversRun: check, email });
  expect(r).toMatchObject({ accepted: false, reason: 'uncovered_refunded' });
  expect(check).toHaveBeenCalledWith(client, expect.objectContaining({ id: 'm-1250', latest_payment_intent_id: 'pi_9' }));
  expect(stripe.refunds).toEqual([{ args: expect.objectContaining({ payment_intent: 'pi_9' }), opts: { idempotencyKey: 'uncovered-payment-pi_9' } }]);
  expect(db.mission).toMatchObject({ status: 'draft', checkout_session_id: null, rejected_payment_intent_ids: ['pi_9'] });
  expect(db.alerts[0]).toMatchObject({ alert_type: 'payment_refunded_mission_changed', mission_id: 'm-1250' });
  expect(db.notifications[0].body).toContain('refunded $9 in full');
  expect(db.notifications[0].body).toContain('$1,099');
  expect(email.sendPaymentRefundedMissionChangedEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'c@x.io', paidUsd: '$9', owedUsd: '$1,099' }));
});

test('a covering payment is accepted untouched', async () => {
  const { db, client } = fakeSupabase({ ...mission, respondent_count: 5, status: 'pending_payment' });
  const stripe = stripeFake();
  const r = await guardPaymentCoversMission({ stripe: stripe.api, supabase: client, pi, checkPaymentCoversRun: async () => ({ ok: true }), email });
  expect(r).toMatchObject({ accepted: true, reason: 'covers' });
  expect(stripe.refunds).toHaveLength(0);
  expect(db.updates).toHaveLength(0);
});

test('when Stripe cannot be read, nothing is refunded on a guess', async () => {
  const { client } = fakeSupabase(mission);
  const stripe = stripeFake();
  const r = await guardPaymentCoversMission({ stripe: stripe.api, supabase: client, pi, checkPaymentCoversRun: async () => ({ ok: false, unverifiable: true }), email });
  expect(r).toMatchObject({ accepted: true, reason: 'unverifiable' });
  expect(stripe.refunds).toHaveLength(0);
});

test('a mission already paid is not judged here, and a rejected payment stays rejected', async () => {
  const stripe = stripeFake();
  const check = jest.fn();
  expect(await guardPaymentCoversMission({ stripe: stripe.api, supabase: fakeSupabase({ ...mission, status: 'paid' }).client, pi, checkPaymentCoversRun: check, email })).toMatchObject({ accepted: true, reason: 'already_past_payment' });
  expect(await guardPaymentCoversMission({ stripe: stripe.api, supabase: fakeSupabase({ ...mission, rejected_payment_intent_ids: ['pi_9'] }).client, pi, checkPaymentCoversRun: check, email })).toMatchObject({ accepted: false, reason: 'already_rejected' });
  expect(check).not.toHaveBeenCalled();
  expect(stripe.refunds).toHaveLength(0);
});

test('expireSessions expires open sessions only and reports failures', async () => {
  const stripe = stripeFake();
  stripe.sessions = { cs_open: 'open', cs_done: 'complete' };
  const r = await expireSessions(stripe.api, ['cs_open', 'cs_done', 'cs_missing', null, 'cs_open']);
  expect(r).toEqual({ expired: ['cs_open'], settled: ['cs_done'], failed: ['cs_missing'] });
});

test('expireSupersededSessions clears what it handled and keeps what failed', async () => {
  const { db, client } = fakeSupabase({ id: 'm', superseded_checkout_session_ids: ['cs_open', 'cs_missing'] });
  const stripe = stripeFake();
  stripe.sessions = { cs_open: 'open' };
  const s = await expireSupersededSessions({ stripe: stripe.api, supabase: client });
  expect(s).toMatchObject({ missions: 1, expired: 1, failed: 1 });
  expect(db.mission.superseded_checkout_session_ids).toEqual(['cs_missing']);
});

describe('refund bookkeeping', () => {
  const { planRefundSync, readMissionStripeState, syncMissionRefunds } = require('../src/services/payments/syncMissionRefunds');
  const pis = {
    pi_rejected: { id: 'pi_rejected', status: 'succeeded', amount_received: 900, latest_charge: { id: 'ch_r', amount_refunded: 900 } },
    pi_real: { id: 'pi_real', status: 'succeeded', amount_received: 109900, latest_charge: { id: 'ch_real', amount_refunded: 0 } },
  };
  const stripe = {
    paymentIntents: {
      retrieve: async (id) => pis[id],
      search: async () => ({ data: [pis.pi_rejected, pis.pi_real] }),
    },
    refunds: { list: async ({ payment_intent }) => ({ data: payment_intent === 'pi_rejected' ? [{ id: 're_r', amount: 900, status: 'succeeded' }] : [] }) },
  };

  test('a refused payment is not part of what the mission was paid', async () => {
    const state = await readMissionStripeState(stripe, { id: 'm', latest_payment_intent_id: 'pi_real', rejected_payment_intent_ids: ['pi_rejected'] });
    expect(state).toMatchObject({ paymentIntentIds: ['pi_real'], capturedCents: 109900, refundedCents: 0, refundIds: [] });
    expect(planRefundSync({ id: 'm', refunded_amount_cents: 0, stripe_refund_ids: [] }, state).changed).toBe(false);
  });

  test('a refund on an unpaid mission is not written (it would breach the paid-only constraint)', async () => {
    const updateMission = jest.fn();
    const supabase = { from: () => { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { id: 'm', paid_at: null, latest_payment_intent_id: 'pi_rejected' }, error: null }) }; return q; } };
    expect(await syncMissionRefunds({ stripe, supabase, updateMission, paymentIntentId: 'pi_rejected' })).toMatchObject({ matched: true, written: false, reason: 'unpaid_mission' });
    expect(updateMission).not.toHaveBeenCalled();
  });
});
