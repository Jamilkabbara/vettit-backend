'use strict';
// Every mission marked paid must be explained. Row shapes are from production.
process.env.NODE_ENV = 'test';
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { explainPaidMission, PAID_WITHOUT_CHARGE_EXCEPTIONS } = require('../src/services/payments/paidMissionAudit');

const noStripe = { paymentIntentIds: [], chargeIds: [], capturedCents: 0, refundedCents: 0, refundIds: [] };
const stripe = (captured, refunded = 0) => ({ paymentIntentIds: ['pi_1'], chargeIds: ['ch_1'], capturedCents: captured, refundedCents: refunded, refundIds: refunded ? ['re_1'] : [] });
const ctx = (stripeState = noStripe, over = {}) => ({ stripeState, promoCodes: new Set(['VETT100']), overrideReasons: new Set(['override-with-reason']), exceptions: {}, ...over });
const row = (over) => ({ id: 'm', paid_at: '2026-09-01', paid_amount_cents: null, refunded_amount_cents: 0, stripe_refund_ids: [], latest_payment_intent_id: null, checkout_session_id: null, promo_code: null, payment_method: null, ...over });

describe('explained', () => {
  test('a Stripe charge that matches the row', () => {
    expect(explainPaidMission(row({ paid_amount_cents: 900, refunded_amount_cents: 900, latest_payment_intent_id: 'pi_1' }), ctx(stripe(900, 900)))).toMatchObject({ ok: true, explanation: 'stripe' });
  });
  test('an April charge found only through Stripe metadata', () => {
    expect(explainPaidMission(row({ paid_amount_cents: 3500, refunded_amount_cents: 3500, stripe_refund_ids: ['re_7'] }), ctx(stripe(3500, 3500)))).toMatchObject({ ok: true, explanation: 'stripe' });
  });
  test('a promo code that exists, with nothing recorded as paid', () => {
    expect(explainPaidMission(row({ promo_code: 'vett100' }), ctx())).toMatchObject({ ok: true, explanation: 'promo' });
  });
  test('an admin override with a written reason', () => {
    expect(explainPaidMission(row({ id: 'override-with-reason', payment_method: 'admin_override' }), ctx())).toMatchObject({ ok: true, explanation: 'admin_override' });
  });
  test('a reviewed exception', () => {
    expect(explainPaidMission(row({ id: 'x' }), ctx(noStripe, { exceptions: { x: 'reviewed' } }))).toMatchObject({ ok: true, explanation: 'reviewed_exception' });
  });
});

describe('unexplained', () => {
  test('23389bb1 without its exception: paid $9, no charge, no promo, no override', () => {
    const m = row({ id: '23389bb1-b30f-4b33-a450-37ded4560307', paid_amount_cents: 900 });
    expect(explainPaidMission(m, ctx())).toMatchObject({ ok: false, problem: 'paid_without_charge_or_reason' });
  });
  test('an internal test run inserted already paid at $0', () => {
    expect(explainPaidMission(row({ paid_amount_cents: 0 }), ctx())).toMatchObject({ ok: false, problem: 'paid_without_charge_or_reason' });
  });
  test('a PaymentIntent on the row that Stripe has no succeeded charge for', () => {
    expect(explainPaidMission(row({ latest_payment_intent_id: 'pi_gone', paid_amount_cents: 900 }), ctx())).toMatchObject({ ok: false, problem: 'stripe_reference_without_charge' });
  });
  test('a recorded amount that differs from what Stripe captured', () => {
    expect(explainPaidMission(row({ latest_payment_intent_id: 'pi_1', paid_amount_cents: 1900 }), ctx(stripe(900)))).toMatchObject({ ok: false, problem: 'recorded_amount_differs_from_stripe' });
  });
  test('a refund Stripe made that the row does not record', () => {
    expect(explainPaidMission(row({ latest_payment_intent_id: 'pi_1', paid_amount_cents: 900 }), ctx(stripe(900, 900)))).toMatchObject({ ok: false, problem: 'recorded_refund_differs_from_stripe' });
  });
  test('an admin override nobody gave a reason for', () => {
    expect(explainPaidMission(row({ id: 'silent', payment_method: 'admin_override' }), ctx())).toMatchObject({ ok: false, problem: 'override_without_reason' });
  });
  test('a promo code that does not exist', () => {
    expect(explainPaidMission(row({ promo_code: 'MADEUP' }), ctx())).toMatchObject({ ok: false, problem: 'unknown_promo_code' });
  });
  test('a promo mission with money recorded but no Stripe charge', () => {
    expect(explainPaidMission(row({ promo_code: 'VETT100', paid_amount_cents: 900 }), ctx())).toMatchObject({ ok: false, problem: 'promo_with_uncharged_amount' });
  });
});

test('the reviewed exceptions are full mission ids, each with a reason', () => {
  for (const [id, reason] of Object.entries(PAID_WITHOUT_CHARGE_EXCEPTIONS)) {
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(reason.length).toBeGreaterThan(30);
  }
});

describe('the daily job alerts once per unexplained mission', () => {
  test('problems become admin alerts; explained missions do not', async () => {
    const inserts = [];
    const chain = (table) => {
      const q = {
        _table: table,
        insert: jest.fn(async (row) => { inserts.push([table, row]); return { error: null }; }),
        select: () => q, eq: () => q, lt: () => q, limit: () => q,
        maybeSingle: async () => ({ data: null }),
        delete: () => q, update: () => q,
        then: (res) => Promise.resolve({ error: null }).then(res),
      };
      return q;
    };
    jest.resetModules();
    jest.doMock('../src/db/supabase', () => ({ from: chain }));
    jest.doMock('../src/services/stripe', () => ({ stripeClient: {} }));
    jest.doMock('../src/jobs/runMission', () => ({ runMission: jest.fn() }));
    const { runJob5PaidAudit } = require('../src/jobs/missionRecovery');
    const audit = jest.fn(async () => ([
      { missionId: 'ok-1', ok: true, explanation: 'stripe' },
      { missionId: 'bad-1', ok: false, explanation: 'none', problem: 'paid_without_charge_or_reason', detail: 'd', title: 't' },
    ]));
    const r = await runJob5PaidAudit({ auditPaidMissions: audit });
    expect(r).toEqual({ checked: 2, unexplained: 1 });
    const alerts = inserts.filter(([t]) => t === 'admin_alerts').map(([, row]) => row);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ alert_type: 'paid_mission_unexplained', mission_id: 'bad-1', payload: { problem: 'paid_without_charge_or_reason' } });
  });
});
