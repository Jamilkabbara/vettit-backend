/**
 * The $0 route obeys max_uses - end to end, through the actual endpoint.
 *
 * /payments/free-launch is the one path that ever spent a use, and it spent it
 * with an un-awaited read-modify-write AFTER marking the mission paid. So the
 * (max+1)th free launch ran, and two at once both ran.
 *
 * What must hold now, at the door a customer actually knocks on:
 *   - the launch after the last use is refused, and the mission is NOT marked
 *     paid and NOT run;
 *   - a code with max_uses NULL keeps launching forever;
 *   - a use spent on a launch that then fails to be marked paid is handed back.
 *
 * MUTATION CHECK: restoring the original route body (mark paid, then fire an
 * un-awaited increment) fails "two simultaneous launches on the last use" and
 * "an increment that fails is a refusal". Recorded in the PR body.
 */
const express = require('express');
const request = require('supertest');
const { makePromoDb, makeGate } = require('./promoDbDouble');

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'u1@test.dev' }; next(); },
  optionalAuthenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'u1@test.dev' }; next(); },
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../src/services/stripe', () => ({
  createCheckoutSession: jest.fn(),
  createPromoOnStripe: jest.fn(),
  updateStripePromoActive: jest.fn(),
}));
jest.mock('../src/services/payments/confirmCheckoutSession', () => ({
  confirmCheckoutSessionPaid: jest.fn(async () => ({})),
}));

const mockRunMission = jest.fn(async () => ({}));
jest.mock('../src/jobs/runMission', () => ({ runMission: mockRunMission }));

let updateMissionBehaviour = async () => ({});
const mockUpdateMission = jest.fn((...args) => updateMissionBehaviour(...args));
jest.mock('../src/db/missionSchema', () => ({
  updateMission: mockUpdateMission,
  sanitizeMissionPatch: (p) => ({ patch: p, rejected: [] }),
}));

// One promo store, plus a missions table that answers with whatever the test
// set up. The promo store is the real thing under test: it evaluates a
// conditional UPDATE the way Postgres does.
let mockPromoDb = makePromoDb([]);
let mockMissionRow = null;
jest.mock('../src/db/supabase', () => {
  const missionChain = () => {
    const resolved = () => ({
      data: mockMissionRow,
      error: mockMissionRow ? null : { message: 'not found' },
    });
    const chain = {
      select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
      update: () => chain, insert: () => chain, is: () => chain, lt: () => chain, gt: () => chain,
      single: async () => resolved(),
      maybeSingle: async () => resolved(),
      then: (onF, onR) => Promise.resolve(resolved()).then(onF, onR),
    };
    return chain;
  };
  return {
    from: (table) => (table === 'promo_codes' ? mockPromoDb.from(table) : missionChain()),
    rpc: (...args) => mockPromoDb.rpc(...args),
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'u1@test.dev' } } }) } },
  };
});

const app = express();
app.use(express.json());
app.use('/api/payments', require('../src/routes/payments'));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

const draft = (over) => ({
  id: 'm1', user_id: 'u1', status: 'draft',
  goal_type: 'validate', respondent_count: 300, media_type: null,
  targeting: {}, questions: [], ...over,
});

const freeLaunch = (missionId, code = 'VETTPROOF') =>
  request(app).post('/api/payments/free-launch').send({ missionId, promoCode: code });

const seed = (over = {}) => ({
  code: 'VETTPROOF', type: 'free', value: 100, active: true,
  max_uses: 1, uses_count: 0, expires_at: null, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  updateMissionBehaviour = async () => ({});
  mockMissionRow = draft();
});

describe('free-launch spends exactly the uses a code has', () => {
  test('the launch after the last use is refused, unpaid and unrun', async () => {
    mockPromoDb = makePromoDb([seed({ max_uses: 1 })]);

    const first = await freeLaunch('m1');
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('processing');
    expect(mockPromoDb.row('VETTPROOF').uses_count).toBe(1);

    jest.clearAllMocks();
    mockMissionRow = draft({ id: 'm2' });
    const second = await freeLaunch('m2');

    expect(second.status).toBe(403);
    expect(second.body.error).toMatch(/fully redeemed|no longer valid/i);
    // The two things that must NOT have happened.
    expect(mockUpdateMission).not.toHaveBeenCalled();
    expect(mockRunMission).not.toHaveBeenCalled();
    expect(mockPromoDb.row('VETTPROOF').uses_count).toBe(1);
  });

  test('a code with max_uses NULL keeps launching', async () => {
    mockPromoDb = makePromoDb([seed({ max_uses: null })]);
    for (const id of ['m1', 'm2', 'm3', 'm4']) {
      mockMissionRow = draft({ id });
      // eslint-disable-next-line no-await-in-loop
      const res = await freeLaunch(id);
      expect(res.status).toBe(200);
    }
    expect(mockPromoDb.row('VETTPROOF').uses_count).toBe(4);
  });

  test('a code that is already at its limit never reaches the mission at all', async () => {
    mockPromoDb = makePromoDb([seed({ max_uses: 5, uses_count: 5 })]);
    const res = await freeLaunch('m1');
    expect(res.status).toBe(403);
    expect(mockUpdateMission).not.toHaveBeenCalled();
    expect(mockRunMission).not.toHaveBeenCalled();
    expect(mockPromoDb.row('VETTPROOF').uses_count).toBe(5);
  });

  test('a launch that fails to be marked paid hands its use back', async () => {
    mockPromoDb = makePromoDb([seed({ max_uses: 2 })]);
    updateMissionBehaviour = async () => { throw new Error('missions update refused'); };

    const res = await freeLaunch('m1');

    expect(res.status).toBe(500);
    expect(mockRunMission).not.toHaveBeenCalled();
    // The customer did not get the launch, so they are not charged the use.
    expect(mockPromoDb.row('VETTPROOF').uses_count).toBe(0);
  });

  test('a retry of an already-paid mission returns already_running and spends nothing', async () => {
    mockPromoDb = makePromoDb([seed({ max_uses: 3 })]);
    mockMissionRow = draft({ status: 'paid' });

    const res = await freeLaunch('m1');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('already_running');
    expect(mockPromoDb.row('VETTPROOF').uses_count).toBe(0);
    expect(mockRunMission).not.toHaveBeenCalled();
  });

  test('two simultaneous launches on the last use: exactly one runs', async () => {
    // Both requests read the count before either writes - the interleaving the
    // old read-modify-write lost on, where both saw 0 of 1 used and both ran.
    const gate = makeGate(2);
    mockPromoDb = makePromoDb([seed({ max_uses: 1 })], { onRead: gate });
    mockMissionRow = draft();

    const [a, b] = await Promise.all([freeLaunch('m1'), freeLaunch('m2')]);

    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([200, 403]);
    expect(mockPromoDb.row('VETTPROOF').uses_count).toBe(1);
    expect(mockRunMission).toHaveBeenCalledTimes(1);
  });

  test('an increment that fails is a refusal, not a silent free launch', async () => {
    // The original code fired the increment without awaiting it and threw the
    // error away, so a write that never landed looked exactly like one that
    // did: the mission ran and the use was never counted.
    mockPromoDb = makePromoDb([seed({ max_uses: 2 })], { failWrites: true });

    const res = await freeLaunch('m1');

    expect(res.status).toBe(403);
    expect(mockRunMission).not.toHaveBeenCalled();
    expect(mockUpdateMission).not.toHaveBeenCalled();
    expect(mockPromoDb.row('VETTPROOF').uses_count).toBe(0);
  });

  test('with pass-53 applied, the same route enforces the same limit', async () => {
    mockPromoDb = makePromoDb([seed({ max_uses: 1 })], { rpcDeployed: true });

    expect((await freeLaunch('m1')).status).toBe(200);
    mockMissionRow = draft({ id: 'm2' });
    expect((await freeLaunch('m2')).status).toBe(403);
    expect(mockPromoDb.row('VETTPROOF').uses_count).toBe(1);
  });
});
