/**
 * A mission must not run for more than it was paid for.
 *
 * The headline case is not a forged mission - it is an honest one that moved.
 * RLS (missions_update_only_while_unpaid) deliberately lets an owner edit a
 * mission while it is draft or pending_payment, because a buyer who has not
 * paid must be able to change their mind. A Stripe Checkout Session, though,
 * is created FROM a pending_payment mission and captures the amount it was
 * created with. So:
 *
 *   1. mission at 5 respondents            -> owed $9
 *   2. open checkout                       -> Session for $9
 *   3. edit respondent_count to 1000       -> RLS allows it, still unpaid
 *   4. pay the $9                          -> webhook marks the mission paid
 *   5. the run reads respondent_count=1000 -> 1000 respondents for $9
 *
 * Nothing misbehaved at any single moment. The price was right when the
 * session was created and right when it was charged. The mission changed
 * between the two, and no other check in the stack looks across that gap.
 *
 * The pricing engine is deliberately NOT mocked: these are real ladder prices.
 */
jest.mock('../src/db/supabase', () => ({ from: jest.fn(), auth: { admin: { getUserById: jest.fn() } } }));
jest.mock('../src/services/stripe', () => ({ retrievePaymentIntent: jest.fn() }));
jest.mock('../src/services/ai/personas', () => ({ generatePersonas: jest.fn() }));
jest.mock('../src/services/ai/simulate', () => ({
  simulateAllResponses: jest.fn(), simulateResponses: jest.fn(), passesScreening: () => true,
}));
jest.mock('../src/services/ai/insights', () => ({ synthesizeInsights: jest.fn(), aggregate: jest.fn(() => ({})) }));
jest.mock('../src/services/ai/simMeta', () => ({ buildSimMeta: jest.fn(() => ({})) }));
jest.mock('../src/services/ai/targetingBrief', () => ({ generateTargetingBrief: jest.fn() }));
jest.mock('../src/services/ai/creativeAttention', () => ({ analyzeCreative: jest.fn() }));
jest.mock('../src/services/ai/recruitLoop', () => ({
  runRecruitmentLoop: jest.fn(), shouldUseRecruitLoop: jest.fn(() => false),
}));
jest.mock('../src/services/ai/persistResponses', () => ({
  persistResponseRows: jest.fn(async () => ({ error: null, inserted: 0 })),
  persistReasoningRows: jest.fn(async () => ({ error: null })),
}));
jest.mock('../src/services/ai/ensureQuestions', () => ({ ensureMissionQuestions: jest.fn(async (m) => m.questions || []) }));
jest.mock('../src/services/analysis', () => ({ computeAnalysis: jest.fn(() => null) }));
jest.mock('../src/services/email', () => ({ sendMissionCompletedEmail: jest.fn(async () => {}), sendMissionFailedEmail: jest.fn(async () => {}) }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/db/missionSchema', () => ({
  updateMission: jest.fn(async () => ({})),
  sanitizeMissionPatch: (p) => ({ patch: p, rejected: [] }),
  stampMissionHeartbeat: jest.fn(async () => ({})),
}));

const supabase = require('../src/db/supabase');
const logger = require('../src/utils/logger');
const stripeService = require('../src/services/stripe');
const { generatePersonas } = require('../src/services/ai/personas');
const { runMission } = require('../src/jobs/runMission');

const MISSION_ID = 'm-cover-test';
let missionRow;
let promoRow;
let alerts;
let claimAttempts;

function wire() {
  alerts = [];
  claimAttempts = 0;
  promoRow = null;
  supabase.from.mockImplementation((table) => {
    if (table === 'admin_alerts') {
      return { insert: async (row) => { alerts.push(row); return { error: null }; } };
    }
    if (table === 'promo_codes') {
      return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: promoRow, error: null }) }) }) }) };
    }
    if (table === 'missions') {
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: missionRow, error: null }) }) }),
        update: () => ({
          eq: () => ({
            eq: () => ({ select: async () => { claimAttempts += 1; return { data: [{ id: MISSION_ID }], error: null }; } }),
            select: async () => { claimAttempts += 1; return { data: [{ id: MISSION_ID }], error: null }; },
          }),
        }),
      };
    }
    return { select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) };
  });
}

// A mission that passes every gate before this one: real goal, real ceiling.
const base = {
  id: MISSION_ID, user_id: 'user-1', title: 'cover gate', status: 'paid',
  goal_type: 'research', media_type: null, targeting: {},
  questions: [{ id: 'q1', text: 'Why?', type: 'open_ended' }],
  ai_spend_ceiling_usd: 270,
  latest_payment_intent_id: 'pi_test_123',
  started_at: null, completed_at: null, failure_reason: null,
};

/** Only the gate's own verdict is measured; later pipeline failure is fine. */
const pastTheGate = async () => {
  try { return await runMission(MISSION_ID); } catch { return 'threw later'; }
};

beforeEach(() => { jest.clearAllMocks(); wire(); });

describe('THE HEADLINE CASE — edited between checkout and capture', () => {
  beforeEach(() => {
    // Paid $9 for 5. Runs as 1000. Real ladder: 1000 x $0.899 = $899.
    missionRow = { ...base, respondent_count: 1000 };
    stripeService.retrievePaymentIntent.mockResolvedValue({ id: 'pi_test_123', amount_received: 900 });
  });

  test('is refused, never claimed, and generates no persona', async () => {
    const out = await pastTheGate();
    expect(out).toEqual({ skipped: true, reason: 'payment_does_not_cover_run' });
    expect(generatePersonas).not.toHaveBeenCalled();
    expect(claimAttempts).toBe(0);
  });

  test('refuses loudly, and the alert carries the real shortfall', async () => {
    await pastTheGate();
    expect(logger.error).toHaveBeenCalled();
    expect(alerts).toHaveLength(1);
    const a = alerts[0];
    expect(a.alert_type).toBe('mission_payment_does_not_cover_run');
    expect(a.mission_id).toBe(MISSION_ID);
    expect(a.resolved).toBe(false);
    expect(a.payload.owed_cents).toBe(89900);      // $899, the run as it stands
    expect(a.payload.captured_cents).toBe(900);    // $9, what Stripe took
    expect(a.payload.shortfall_cents).toBe(89000); // $890 of free compute
    expect(a.payload.captured_from).toBe('stripe');
  });
});

test('Stripe is the record of truth, not the mission row', async () => {
  // The row claims a full payment; Stripe says $9 was captured. Stripe wins.
  missionRow = { ...base, respondent_count: 1000, paid_amount_cents: 89900 };
  stripeService.retrievePaymentIntent.mockResolvedValue({ amount_received: 900 });
  const out = await pastTheGate();
  expect(out).toEqual({ skipped: true, reason: 'payment_does_not_cover_run' });
  expect(alerts[0].payload.captured_from).toBe('stripe');
});

test('a backfilled paid_amount_cents is not evidence of payment', async () => {
  // paid_amount_estimated=true means it was derived from the mission's OWN
  // total_price_usd. Trusting it would make the gate circular.
  missionRow = {
    ...base, respondent_count: 1000, latest_payment_intent_id: null,
    paid_amount_cents: 89900, paid_amount_estimated: true,
  };
  const out = await pastTheGate();
  expect(out).toEqual({ skipped: true, reason: 'payment_does_not_cover_run' });
  expect(alerts[0].payload.captured_cents).toBe(0);
  expect(alerts[0].payload.captured_from).toBe('none');
});

test('no payment record at all is zero captured, not "assume it is fine"', async () => {
  missionRow = { ...base, respondent_count: 1000, latest_payment_intent_id: null, paid_amount_cents: null };
  const out = await pastTheGate();
  expect(out).toEqual({ skipped: true, reason: 'payment_does_not_cover_run' });
  expect(alerts[0].payload.captured_cents).toBe(0);
});

test('the gate covers a RESUME, which bypasses the paid claim by design', async () => {
  missionRow = { ...base, respondent_count: 1000, status: 'processing', started_at: new Date().toISOString() };
  stripeService.retrievePaymentIntent.mockResolvedValue({ amount_received: 900 });
  const out = await runMission(MISSION_ID, { resume: true });
  expect(out).toEqual({ skipped: true, reason: 'payment_does_not_cover_run' });
  expect(generatePersonas).not.toHaveBeenCalled();
});

describe('a mission the ladder cannot price is refused, not waved through', () => {
  // Fail-closed, matching create-checkout-session and free-launch: if we cannot
  // work out what a mission costs, we cannot claim its payment covers it. This
  // is not hypothetical - 14 missions on production cannot be priced (10 CA
  // rows holding respondent_count=1 from before the CA floor, plus 4 brand_lift
  // rows under the 100 floor). All of them are finished, so they sit behind the
  // terminal-status skip; an admin force-run is what would reach this branch.

  test('a CA mission under the ladder floor cannot be priced, so it does not run', async () => {
    missionRow = {
      ...base, goal_type: 'creative_attention', media_type: 'image', respondent_count: 1,
    };
    stripeService.retrievePaymentIntent.mockResolvedValue({ amount_received: 1900 });
    const out = await pastTheGate();
    expect(out).toEqual({ skipped: true, reason: 'payment_does_not_cover_run' });
    expect(generatePersonas).not.toHaveBeenCalled();
  });

  test('paying generously does not buy past an unpriceable mission', async () => {
    missionRow = {
      ...base, goal_type: 'creative_attention', media_type: 'image', respondent_count: 1,
    };
    stripeService.retrievePaymentIntent.mockResolvedValue({ amount_received: 999999 });
    const out = await pastTheGate();
    expect(out).toEqual({ skipped: true, reason: 'payment_does_not_cover_run' });
  });

  test('the alert says WHY it could not be priced', async () => {
    missionRow = {
      ...base, goal_type: 'creative_attention', media_type: 'image', respondent_count: 1,
    };
    await pastTheGate();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].payload.captured_from).toBe('unpriced');
    expect(alerts[0].payload.pricing_error).toMatch(/creative_attention/i);
  });
});

describe('CONTROL — missions that were genuinely paid for still run', () => {
  test('paid the full amount for the size it will actually run', async () => {
    missionRow = { ...base, respondent_count: 1000 };
    stripeService.retrievePaymentIntent.mockResolvedValue({ amount_received: 89900 });
    const out = await pastTheGate();
    expect(out).not.toEqual({ skipped: true, reason: 'payment_does_not_cover_run' });
    expect(claimAttempts).toBeGreaterThan(0);
    expect(alerts.filter((a) => a.alert_type === 'mission_payment_does_not_cover_run')).toHaveLength(0);
  });

  test('a small mission paid at its own small price', async () => {
    missionRow = { ...base, respondent_count: 5 };
    stripeService.retrievePaymentIntent.mockResolvedValue({ amount_received: 900 });
    const out = await pastTheGate();
    expect(out).not.toEqual({ skipped: true, reason: 'payment_does_not_cover_run' });
    expect(claimAttempts).toBeGreaterThan(0);
  });

  test('paying MORE than owed is never a refusal', async () => {
    missionRow = { ...base, respondent_count: 5 };
    stripeService.retrievePaymentIntent.mockResolvedValue({ amount_received: 5000 });
    const out = await pastTheGate();
    expect(out).not.toEqual({ skipped: true, reason: 'payment_does_not_cover_run' });
  });

  test('a mission charged BEFORE whole-dollar rounding is not refused by it', async () => {
    // 10 respondents: ladder $15.60 exact, charged $16 since #160. A customer
    // billed $15.60 last month must still resume. Comparing against the exact
    // total (not the rounded charge) is what makes that true.
    missionRow = { ...base, respondent_count: 10 };
    stripeService.retrievePaymentIntent.mockResolvedValue({ amount_received: 1560 });
    const out = await pastTheGate();
    expect(out).not.toEqual({ skipped: true, reason: 'payment_does_not_cover_run' });
    expect(alerts.filter((a) => a.alert_type === 'mission_payment_does_not_cover_run')).toHaveLength(0);
  });

  test('a price that rounds DOWN is not refused for the missing cents', async () => {
    // 60 respondents: ladder $89.40 exact, charged $89 since #160 - Math.round
    // rounds DOWN below 50 cents. Comparing against the exact total alone would
    // refuse this mission on its FIRST run with a completely correct payment,
    // and roughly half the ladder rounds this way. This is the case that makes
    // "owed" the minimum of the two, not the exact figure.
    missionRow = { ...base, respondent_count: 60 };
    stripeService.retrievePaymentIntent.mockResolvedValue({ amount_received: 8900 });
    const out = await pastTheGate();
    expect(out).not.toEqual({ skipped: true, reason: 'payment_does_not_cover_run' });
    expect(alerts.filter((a) => a.alert_type === 'mission_payment_does_not_cover_run')).toHaveLength(0);
  });

  test('rounding tolerance is cents wide, not dollars — a real shortfall still fires', async () => {
    // One dollar short of the $89 charge is still a refusal. The min() above
    // widens the bar by at most 99 cents, never into a business allowance.
    missionRow = { ...base, respondent_count: 60 };
    stripeService.retrievePaymentIntent.mockResolvedValue({ amount_received: 8800 });
    const out = await pastTheGate();
    expect(out).toEqual({ skipped: true, reason: 'payment_does_not_cover_run' });
  });

  test('a genuine free-promo mission owes nothing, so zero covers it', async () => {
    promoRow = { code: 'VETTFREE', type: 'free', active: true, expires_at: null, max_uses: null, uses_count: 0 };
    missionRow = {
      ...base, respondent_count: 5, promo_code: 'VETTFREE',
      latest_payment_intent_id: null, paid_amount_cents: null,
    };
    const out = await pastTheGate();
    expect(out).not.toEqual({ skipped: true, reason: 'payment_does_not_cover_run' });
  });

  test('an INACTIVE promo is not honoured — the mission owes list price', async () => {
    promoRow = null; // the query filters on active=true
    missionRow = {
      ...base, respondent_count: 1000, promo_code: 'EXPIRED',
      latest_payment_intent_id: null, paid_amount_cents: null,
    };
    const out = await pastTheGate();
    expect(out).toEqual({ skipped: true, reason: 'payment_does_not_cover_run' });
    expect(alerts[0].payload.owed_cents).toBe(89900);
    expect(alerts[0].payload.promo_honoured).toBeNull();
  });
});

test('a Stripe outage falls back to the row, it does not become a free run', async () => {
  missionRow = { ...base, respondent_count: 1000, paid_amount_cents: 89900 };
  stripeService.retrievePaymentIntent.mockRejectedValue(new Error('stripe down'));
  const out = await pastTheGate();
  expect(out).not.toEqual({ skipped: true, reason: 'payment_does_not_cover_run' });
  expect(logger.warn).toHaveBeenCalled();
});

test('a Stripe outage with NO row evidence still refuses', async () => {
  missionRow = { ...base, respondent_count: 1000, paid_amount_cents: null };
  stripeService.retrievePaymentIntent.mockRejectedValue(new Error('stripe down'));
  const out = await pastTheGate();
  expect(out).toEqual({ skipped: true, reason: 'payment_does_not_cover_run' });
});
