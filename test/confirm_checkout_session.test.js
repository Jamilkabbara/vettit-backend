/**
 * Pass 46 Phase 2 — checkout-session success fallback (audit P0-1).
 *
 * The success page's poll must be able to confirm payment + fire the
 * pipeline (the live Stripe account had no webhook), idempotently.
 */

jest.mock('../src/db/missionSchema', () => ({
  updateMission: jest.fn().mockResolvedValue({}),
  sanitizeMissionPatch: jest.fn((p) => ({ patch: p, rejected: [] })),
  // Pass 49 — heartbeat_at availability latch (migration applied by hand).
  isHeartbeatColumnMissing: jest.fn(() => false),
  noteHeartbeatColumnMissing: jest.fn(() => false),
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { updateMission } = require('../src/db/missionSchema');
const { confirmCheckoutSessionPaid } = require('../src/services/payments/confirmCheckoutSession');

function makeSupabase({ missionRow } = {}) {
  const funnelInserts = [];
  return {
    funnelInserts,
    from(table) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        single: async () => ({ data: missionRow ?? null, error: missionRow ? null : { message: 'not found' } }),
        insert: async (row) => {
          if (table === 'funnel_events') funnelInserts.push(row);
          return { error: null };
        },
      };
      return chain;
    },
  };
}

function paidSession(overrides = {}) {
  return {
    id: 'cs_test_1',
    status: 'complete',
    payment_status: 'paid',
    amount_total: 12000,
    payment_intent: 'pi_test_1',
    metadata: { missionId: 'mission-1' },
    ...overrides,
  };
}

const flushImmediates = () => new Promise((r) => setImmediate(r));

beforeEach(() => jest.clearAllMocks());

test('pending_payment + paid session → marks paid and triggers runMission exactly once', async () => {
  const supabase = makeSupabase({ missionRow: { id: 'mission-1', status: 'pending_payment', user_id: 'u1' } });
  const runMission = jest.fn().mockResolvedValue({});

  const r = await confirmCheckoutSessionPaid({ supabase, runMission }, paidSession());
  await flushImmediates();

  expect(r.triggered).toBe(true);
  expect(updateMission).toHaveBeenCalledTimes(1);
  const patch = updateMission.mock.calls[0][2];
  expect(patch.status).toBe('paid');
  expect(patch.latest_payment_intent_id).toBe('pi_test_1');
  expect(patch.paid_amount_cents).toBe(12000);
  expect(runMission).toHaveBeenCalledWith('mission-1');
  expect(supabase.funnelInserts).toHaveLength(1);
  expect(supabase.funnelInserts[0].event_type).toBe('mission_paid');
});

test('idempotent: mission already past pending_payment → no mutation, no trigger', async () => {
  for (const status of ['paid', 'processing', 'completed', 'failed']) {
    jest.clearAllMocks();
    const supabase = makeSupabase({ missionRow: { id: 'mission-1', status, user_id: 'u1' } });
    const runMission = jest.fn();
    const r = await confirmCheckoutSessionPaid({ supabase, runMission }, paidSession());
    await flushImmediates();
    expect(r.triggered).toBe(false);
    expect(r.reason).toBe(`already_${status}`);
    expect(updateMission).not.toHaveBeenCalled();
    expect(runMission).not.toHaveBeenCalled();
  }
});

test('unpaid / incomplete sessions never trigger', async () => {
  const supabase = makeSupabase({ missionRow: { id: 'mission-1', status: 'pending_payment', user_id: 'u1' } });
  const runMission = jest.fn();

  for (const s of [
    paidSession({ status: 'open' }),
    paidSession({ payment_status: 'unpaid' }),
    paidSession({ metadata: {} }),
  ]) {
    const r = await confirmCheckoutSessionPaid({ supabase, runMission }, s);
    expect(r.triggered).toBe(false);
  }
  expect(runMission).not.toHaveBeenCalled();
  expect(updateMission).not.toHaveBeenCalled();
});
