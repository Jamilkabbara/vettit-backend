/**
 * The spend ceiling runs on the existing recovery cron, under the existing
 * distributed lock.
 *
 * Two properties matter more than the happy path:
 *
 *   - It takes and RELEASES the cron_locks row. A job that leaks its lock
 *     stops running after one tick and does so silently, which for a tripwire
 *     means it is dead without ever reporting that it is dead. The lock is
 *     only stolen after 15 minutes, and this job ticks hourly, so a leak
 *     would look self-healing and therefore stay invisible.
 *
 *   - It is non-fatal. It shares a process with the watchdogs that unstick
 *     paid missions; a spend check that throws must not take those down.
 */
process.env.NODE_ENV = 'test';

jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/stripe', () => ({ stripeClient: {}, retrievePaymentIntent: jest.fn() }));
// runMission pulls services/email, which builds a Resend client at module
// load and throws without a key. Job 6 never touches either.
jest.mock('../src/jobs/runMission', () => ({ runMission: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/db/missionSchema', () => ({
  updateMission: jest.fn().mockResolvedValue({}),
  sanitizeMissionPatch: jest.fn((p) => ({ patch: p, rejected: [] })),
  isHeartbeatColumnMissing: jest.fn(() => false),
  noteHeartbeatColumnMissing: jest.fn(() => false),
}));

const mockLocks = { acquired: [], released: [] };
const mockLockState = { granted: true };

jest.mock('../src/db/supabase', () => ({
  from: (table) => {
    if (table === 'cron_locks') {
      return {
        insert: async (row) => {
          if (!mockLockState.granted) return { error: { code: '23505' } };
          mockLocks.acquired.push(row.job_name);
          return { error: null };
        },
        update: () => ({ eq: () => ({ lt: () => ({ select: async () => ({ data: [], error: null }) }) }) }),
        delete: () => ({
          eq: (col, val) => ({
            eq: () => ({
              then: (f) => { if (col === 'job_name') mockLocks.released.push(val); f(); return { catch: () => {} }; },
            }),
          }),
        }),
      };
    }
    throw new Error(`unexpected table: ${table}`);
  },
  auth: { admin: { getUserById: jest.fn() } },
}));

const { runJob6SpendCeiling } = require('../src/jobs/missionRecovery');

beforeEach(() => {
  mockLocks.acquired = [];
  mockLocks.released = [];
  mockLockState.granted = true;
});

test('it checks the ceiling under its own lock, and gives the lock back', async () => {
  const runMonthlyCeilingCheck = jest.fn(async () => ({
    month: '2026-11', spendUsd: 5.9435, ceilingUsd: 50, breached: false, hardBreached: false,
    alert: { raised: false, reason: 'under_ceiling' },
  }));

  const out = await runJob6SpendCeiling({ runMonthlyCeilingCheck });

  expect(out).toMatchObject({ month: '2026-11', breached: false });
  expect(runMonthlyCeilingCheck).toHaveBeenCalledTimes(1);
  expect(mockLocks.acquired).toEqual(['ai_monthly_spend_ceiling']);
  expect(mockLocks.released).toEqual(['ai_monthly_spend_ceiling']);
});

test('another instance holding the lock means this tick does nothing', async () => {
  mockLockState.granted = false;
  const runMonthlyCeilingCheck = jest.fn();
  expect(await runJob6SpendCeiling({ runMonthlyCeilingCheck })).toEqual({ skipped: true, reason: 'lock' });
  expect(runMonthlyCeilingCheck).not.toHaveBeenCalled();
});

test('a throwing check is swallowed, and the lock is still released', async () => {
  const runMonthlyCeilingCheck = jest.fn(async () => { throw new Error('supabase down'); });
  const out = await runJob6SpendCeiling({ runMonthlyCeilingCheck });
  expect(out).toMatchObject({ failed: true, reason: 'supabase down' });
  expect(mockLocks.released).toEqual(['ai_monthly_spend_ceiling']);
});

test('the cron starts no timers under NODE_ENV=test', () => {
  const { init, shutdown } = require('../src/jobs/missionRecovery');
  expect(() => { init(); shutdown(); }).not.toThrow();
});
