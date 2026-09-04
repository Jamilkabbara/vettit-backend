/**
 * missionRecovery Job 2 must bind a PaymentIntent to the mission it recovers.
 *
 * THE HOLE. The RLS policy on `missions` is ownership-only with NO column
 * restriction (measured: missions_update USING/WITH CHECK auth.uid() =
 * user_id, and `authenticated` holds UPDATE on all 20 money/lifecycle
 * columns). So a signed-in user can write `status` and
 * `latest_payment_intent_id` on their own row through the anon key.
 *
 * Job 2 then retrieved that PI and flipped the mission to paid on
 * `pi.status === 'succeeded'` ALONE. Chained:
 *
 *   1. pay for one cheap mission, keep the succeeded PI id
 *   2. create a new mission at the top of the self-serve range
 *   3. write status='pending_payment' + latest_payment_intent_id=<that PI>
 *   4. Job 2 marks it paid and calls runMission
 *
 * and the PI is reusable indefinitely, because nothing marks one consumed.
 *
 * Every PI this app creates carries metadata.missionId (services/stripe.js),
 * and the webhook path already keys off it (routes/webhooks.js:216,325).
 * Job 2 simply was not using it.
 *
 * These tests assert the REFUSAL and that no mission runs. A recovery that
 * happens and is merely logged is not a fix, so every refusal also asserts
 * runMission was called zero times and the row was not marked paid.
 */

jest.mock('../src/db/supabase', () => ({ from: jest.fn() }));
jest.mock('../src/jobs/runMission', () => ({ runMission: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/db/missionSchema', () => ({
  updateMission: jest.fn().mockResolvedValue({}),
  sanitizeMissionPatch: jest.fn((p) => ({ patch: p, rejected: [] })),
  isHeartbeatColumnMissing: jest.fn(() => false),
  noteHeartbeatColumnMissing: jest.fn(() => false),
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../src/services/stripe', () => ({ retrievePaymentIntent: jest.fn() }));

const supabase       = require('../src/db/supabase');
const stripeService  = require('../src/services/stripe');
const { runMission } = require('../src/jobs/runMission');
const { updateMission } = require('../src/db/missionSchema');
const { reconcileOrphanPendingPayment } = require('../src/jobs/missionRecovery');

/** admin_alerts rows Job 2 wrote this test. */
let alerts = [];

// Job 2 fires runMission from setImmediate. Without draining the queue after
// each test, a callback queued by one test lands inside the next one and is
// counted there - which made the positive control read 4 calls instead of 1
// and masked the mutation check. Drain, THEN clear.
afterEach(async () => { await new Promise((r) => setImmediate(r)); });

beforeEach(() => {
  jest.clearAllMocks();
  alerts = [];
  supabase.from.mockImplementation((table) => {
    const chain = {
      select: () => chain, eq: () => chain, is: () => chain, order: () => chain,
      limit: () => chain, update: () => chain,
      insert: (row) => {
        if (table === 'admin_alerts') alerts.push(Array.isArray(row) ? row[0] : row);
        return chain;
      },
      single:      async () => ({ data: null, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (onF, onR) => Promise.resolve({ data: [], error: null }).then(onF, onR),
    };
    return chain;
  });
});

const THIS_MISSION  = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_MISSION = 'bbbbbbbb-0000-0000-0000-000000000002';

const mission = (over = {}) => ({
  id: THIS_MISSION,
  user_id: 'u1',
  status: 'pending_payment',
  latest_payment_intent_id: 'pi_reused',
  total_price_usd: 968.75,             // top of the self-serve range
  title: 'expensive study',
  created_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString(), // old enough
  ...over,
});

const pi = (over = {}) => ({
  id: 'pi_reused',
  status: 'succeeded',
  amount: 900, amount_received: 900,   // a $9 payment
  created: Math.floor(Date.now() / 1000),
  metadata: { missionId: THIS_MISSION },
  ...over,
});

/** Nothing was recovered and nothing was run. */
const assertRefused = () => {
  expect(runMission).toHaveBeenCalledTimes(0);
  const markedPaid = updateMission.mock.calls.some((c) => c[2] && c[2].status === 'paid');
  expect(markedPaid).toBe(false);
};

describe('Job 2 refuses a PaymentIntent that is not bound to this mission', () => {
  test('a succeeded PI created for a DIFFERENT mission does not recover or run', async () => {
    stripeService.retrievePaymentIntent.mockResolvedValue(
      pi({ metadata: { missionId: OTHER_MISSION } })
    );
    await reconcileOrphanPendingPayment(mission());
    assertRefused();
    expect(alerts.map((a) => a.alert_type || a.type)).toContain('pi_mission_id_mismatch');
  });

  test('a succeeded PI with no missionId metadata does not recover or run', async () => {
    stripeService.retrievePaymentIntent.mockResolvedValue(pi({ metadata: {} }));
    await reconcileOrphanPendingPayment(mission());
    assertRefused();
  });

  test('a bound PI that captured LESS than the mission price does not recover or run', async () => {
    // $9 captured against a $968.75 mission - bound, succeeded, still not payment.
    stripeService.retrievePaymentIntent.mockResolvedValue(pi());
    await reconcileOrphanPendingPayment(mission());
    assertRefused();
  });
});

describe('positive control: a genuine webhook miss still recovers', () => {
  test('bound PI, succeeded, amount covers the price -> marked paid and run', async () => {
    stripeService.retrievePaymentIntent.mockResolvedValue(
      pi({ amount: 96875, amount_received: 96875 })
    );
    await reconcileOrphanPendingPayment(mission());
    const markedPaid = updateMission.mock.calls.some((c) => c[2] && c[2].status === 'paid');
    expect(markedPaid).toBe(true);
    // runMission is fired from setImmediate - let the queue drain.
    await new Promise((r) => setImmediate(r));
    expect(runMission).toHaveBeenCalledTimes(1);
  });
});
