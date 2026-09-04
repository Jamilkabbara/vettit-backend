/**
 * A brand_lift study below the Pulse minimum has NO tier on the brand-lift
 * ladder. resolveTier says so by returning null. calculateMissionPrice then
 * ignored the null and repriced onto a ladder the mission does not belong to:
 *
 *   ratePerResp = tier?.ratePerResp || VOLUME_TIERS[0].ratePerResp   // $1.80
 *   volumeTier  = tier || VOLUME_TIERS[0]                            // Sniff Test
 *
 * That is what charged a brand_lift study n=5 x $1.80 = $9.00 and wrote
 * "Sniff Test" onto the stored breakdown and the Stripe receipt. n=49 came out
 * at $88.20 the same way. Creative Attention below its floor took the matching
 * packagePrice fallback and came out at the flat $19, also labelled "Sniff
 * Test", with anchorCount 10 - a Sniff Test tier that exists on neither ladder
 * the mission was priced against.
 *
 * The fix is two-sided, and both sides are needed:
 *
 *   Engine   a null tier now throws UnpriceableMissionError instead of
 *            quietly picking a different ladder. Silence is what made this
 *            survive: every wrong price looked like a real one.
 *
 *   Routes   every door that creates or re-prices a mission rejects a
 *            below-floor goal FIRST, so the throw is a backstop and not the
 *            user-facing behaviour. POST /missions had a Creative Attention
 *            floor and no brand_lift floor; /draft and PATCH had neither.
 *
 * The owner's decision is REJECT, not reprice. Repricing n=5 onto the
 * brand-lift ladder would charge $99 for a 3-vs-2 comparison that the
 * cell-size floor shipped in #120 refuses to call significant - worse for the
 * customer than the $9 it charges today.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'u1@test.dev' }; next(); },
  optionalAuthenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'u1@test.dev' }; next(); },
}));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockCreatePaymentIntent = jest.fn(async () => ({ clientSecret: 'cs_secret', paymentIntentId: 'pi_test' }));
const mockCreateCheckoutSession = jest.fn(async () => ({ id: 'cs_test', url: 'https://stripe.test/cs', paymentIntentId: 'pi_test' }));
jest.mock('../src/services/stripe', () => ({
  createCheckoutSession: mockCreateCheckoutSession,
  createPaymentIntent: mockCreatePaymentIntent,
  createPromoOnStripe: jest.fn(),
  updateStripePromoActive: jest.fn(),
}));
jest.mock('../src/jobs/runMission', () => ({ runMission: jest.fn(async () => ({})) }));

const mockUpdateMission = jest.fn(async () => ({}));
jest.mock('../src/db/missionSchema', () => ({
  updateMission: mockUpdateMission,
  sanitizeMissionPatch: (p) => ({ patch: p, rejected: [] }),
}));

let mockMissionRow = null;
let lastInsert = null;
let lastUpdate = null;
jest.mock('../src/db/supabase', () => {
  const makeChain = (table) => {
    let inserted = null;
    const resolved = () => {
      if (table === 'promo_codes') return { data: null, error: { message: 'not found' } };
      if (table === 'mission_responses') return { data: [], error: null, count: 0 };
      const row = inserted || mockMissionRow;
      return { data: row, error: row ? null : { message: 'not found' } };
    };
    const chain = {
      select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
      update: (row) => { lastUpdate = row; return chain; },
      insert: (row) => { lastInsert = row; inserted = { id: 'm-new', ...row }; return chain; },
      single: async () => resolved(),
      maybeSingle: async () => resolved(),
      then: (onF, onR) => Promise.resolve(resolved()).then(onF, onR),
    };
    return chain;
  };
  return {
    from: (table) => makeChain(table),
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'u1@test.dev' } } }) } },
  };
});

const app = express();
app.use(express.json());
app.use('/api/missions', require('../src/routes/missions'));
app.use('/api/payments', require('../src/routes/payments'));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message, name: err.name }));

const {
  calculateMissionPrice,
  BRAND_LIFT_MIN_RESPONDENTS,
  CA_MIN_RESPONDENTS,
  BRAND_LIFT_TIERS,
  CREATIVE_ATTENTION_TIERS,
} = require('../src/utils/pricingEngine');

const BL_MIN = BRAND_LIFT_MIN_RESPONDENTS;
// brand_lift create also requires at least one market and one channel.
const blBody = (n) => ({
  goalType: 'brand_lift', brief: 'x', respondentCount: n,
  targetedMarkets: ['US'], campaignChannels: ['meta'],
});

beforeEach(() => {
  mockCreatePaymentIntent.mockClear();
  mockCreateCheckoutSession.mockClear();
  mockUpdateMission.mockClear();
  mockMissionRow = null; lastInsert = null; lastUpdate = null;
});

// ── Engine: a null tier fails loudly instead of repricing onto another ladder ─

describe('calculateMissionPrice refuses a combo that has no tier', () => {
  test.each([
    ['brand_lift',         1],
    ['brand_lift',         5],
    ['brand_lift',         BL_MIN - 1],
    ['creative_attention', 1],
    ['creative_attention', CA_MIN_RESPONDENTS - 1],
  ])('%s n=%i throws rather than manufacturing a price', (goalType, respondentCount) => {
    expect(() => calculateMissionPrice({
      goalType, respondentCount, mediaType: 'image',
    })).toThrow(/unpriceable|no tier|minimum/i);
  });

  test('the throw is typed and carries a 400, not a bare Error', () => {
    let caught = null;
    try { calculateMissionPrice({ goalType: 'brand_lift', respondentCount: 5 }); }
    catch (e) { caught = e; }
    expect(caught).not.toBeNull();
    expect(caught.name).toBe('UnpriceableMissionError');
    expect(caught.code).toBe('unpriceable_mission');
    expect(caught.statusCode).toBe(400);
    expect(caught.goalType).toBe('brand_lift');
    expect(caught.respondentCount).toBe(5);
    expect(caught.minRespondents).toBe(BL_MIN);
  });
});

describe('no brand_lift or CA price can carry a tier from another ladder', () => {
  const blIds = new Set(BRAND_LIFT_TIERS.map(t => t.id));
  const caIds = new Set(CREATIVE_ATTENTION_TIERS.map(t => t.id));

  // 50 and 99 dropped: below the floor there is no tier to land on, which the
  // refusal tests above cover. These are the counts that ARE buyable.
  test.each([100, 200, 300, 500, 800, 1250])('brand_lift n=%i lands on a brand-lift tier', (n) => {
    const p = calculateMissionPrice({ goalType: 'brand_lift', respondentCount: n });
    expect(blIds.has(p.volumeTier.id)).toBe(true);
    expect(BRAND_LIFT_TIERS.find(t => t.id === p.volumeTier.id).anchorCount).toBe(p.volumeTier.anchorCount);
  });

  test.each([10, 25, 50, 100, 250, 1000])('creative_attention n=%i lands on a CA tier', (n) => {
    const p = calculateMissionPrice({ goalType: 'creative_attention', respondentCount: n, mediaType: 'image' });
    expect(caIds.has(p.volumeTier.id)).toBe(true);
    expect(CREATIVE_ATTENTION_TIERS.find(t => t.id === p.volumeTier.id).anchorCount).toBe(p.volumeTier.anchorCount);
  });
});

// ── Routes: reject at the door, so the throw is a backstop ───────────────────

describe('POST /api/missions rejects a below-floor brand_lift instead of storing a $9 row', () => {
  test(`n=5 is refused and nothing is inserted`, async () => {
    const res = await request(app).post('/api/missions').send(blBody(5));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('min_respondents');
    expect(res.body.message).toContain(String(BL_MIN));
    expect(lastInsert).toBeNull();
  });

  test(`n=${BL_MIN - 1} is refused`, async () => {
    const res = await request(app).post('/api/missions').send(blBody(BL_MIN - 1));
    expect(res.status).toBe(400);
    expect(lastInsert).toBeNull();
  });

  test('the existing creative_attention floor still fires', async () => {
    const res = await request(app).post('/api/missions')
      .send({ goalType: 'creative_attention', brief: 'x', respondentCount: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('min_respondents');
    expect(lastInsert).toBeNull();
  });
});

describe('POST /api/missions/draft applies the same floors', () => {
  test('brand_lift n=5 is refused', async () => {
    const res = await request(app).post('/api/missions/draft').send(blBody(5));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('min_respondents');
    expect(lastInsert).toBeNull();
  });

  test('creative_attention n=1 is refused', async () => {
    const res = await request(app).post('/api/missions/draft')
      .send({ goalType: 'creative_attention', brief: 'x', respondentCount: 1 });
    expect(res.status).toBe(400);
    expect(lastInsert).toBeNull();
  });
});

describe('PATCH /api/missions/:id cannot re-price a mission below its floor', () => {
  test('editing a brand_lift mission down to n=5 is refused, and nothing is written', async () => {
    mockMissionRow = {
      id: 'm1', user_id: 'u1', goal_type: 'brand_lift', status: 'draft',
      respondent_count: 200, media_type: null, targeting: {}, questions: [],
    };
    const res = await request(app).patch('/api/missions/m1').send({ respondentCount: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('min_respondents');
    expect(lastUpdate).toBeNull();
  });

  test('switching a validate mission to brand_lift at n=5 is refused', async () => {
    mockMissionRow = {
      id: 'm1', user_id: 'u1', goal_type: 'validate', status: 'draft',
      respondent_count: 5, media_type: null, targeting: {}, questions: [],
    };
    const res = await request(app).patch('/api/missions/m1')
      .send({ goalType: 'brand_lift', respondentCount: 5 });
    expect(res.status).toBe(400);
    expect(lastUpdate).toBeNull();
  });
});

describe('the price-preview endpoints answer 400, not 500', () => {
  test.each(['/api/missions/calculate-price', '/api/missions/pricing/calculate'])('%s', async (path) => {
    const res = await request(app).post(path).send({ goalType: 'brand_lift', respondentCount: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unpriceable_mission');
    expect(res.body.message).toContain(String(BL_MIN));
  });
});

// ── POSITIVE CONTROL ────────────────────────────────────────────────────────
//
// Every assertion above is a rejection. Without these, a change that refused
// every mission, or threw on every price, would pass the whole file.

describe('positive control - legal missions are unaffected, at unchanged prices', () => {
  test.each([
    ['validate',   5,   9],
    ['validate',   10,  35],
    ['validate',   50,  99],
    ['validate',   250, 300],
    ['brand_lift', 100, 150],   // was [50, 99]; the floor moved and Pulse is unbuyable
    ['brand_lift', 200, 300],
    ['brand_lift', 500, 600],
  ])('%s n=%i still prices at $%i', (goalType, n, expected) => {
    expect(calculateMissionPrice({ goalType, respondentCount: n }).total).toBe(expected);
  });

  test.each([[10, 19], [25, 39], [50, 69], [100, 129], [250, 299]])(
    'creative_attention n=%i still prices at $%i', (n, expected) => {
      expect(calculateMissionPrice({
        goalType: 'creative_attention', respondentCount: n, mediaType: 'image',
      }).total).toBe(expected);
    });

  test('validate n=5 keeps the real Sniff Test tier - the label is only wrong off-ladder', () => {
    const p = calculateMissionPrice({ goalType: 'validate', respondentCount: 5 });
    expect(p.volumeTier.name).toBe('Sniff Test');
    expect(p.total).toBe(9);
  });

  test('POST /api/missions creates a legal brand_lift mission', async () => {
    const res = await request(app).post('/api/missions').send(blBody(200));
    expect(res.status).toBe(201);
    expect(lastInsert).not.toBeNull();
    expect(lastInsert.respondent_count).toBe(200);
  });

  test('POST /api/missions/draft creates a legal validate draft', async () => {
    const res = await request(app).post('/api/missions/draft')
      .send({ goalType: 'validate', brief: 'x', respondentCount: 50 });
    expect(res.status).toBe(200);   // /draft answers 200, unlike POST / which answers 201
    expect(lastInsert.total_price_usd).toBe(99);
  });

  test('PATCH still re-prices a legal edit', async () => {
    mockMissionRow = {
      id: 'm1', user_id: 'u1', goal_type: 'brand_lift', status: 'draft',
      respondent_count: 200, media_type: null, targeting: {}, questions: [],
    };
    const res = await request(app).patch('/api/missions/m1').send({ respondentCount: 500 });
    expect(res.status).not.toBe(400);
    expect(lastUpdate.total_price_usd).toBe(600);
  });

  test('the preview endpoints still answer a legal request', async () => {
    const res = await request(app).post('/api/missions/calculate-price')
      .send({ goalType: 'brand_lift', respondentCount: 200, questionCount: 5 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(300);
  });

  test('POST /api/missions/launch still opens a PaymentIntent for a legal mission', async () => {
    mockMissionRow = {
      id: 'm1', user_id: 'u1', goal_type: 'brand_lift', status: 'draft',
      respondent_count: 200, media_type: null, targeting: {}, questions: [],
    };
    const res = await request(app).post('/api/missions/launch').send({ missionId: 'm1' });
    expect(res.status).toBe(200);
    expect(mockCreatePaymentIntent.mock.calls[0][0].amountCents).toBe(30000);
  });
});

// ── The backstop must never be the user-facing behaviour ────────────────────

describe('the money doors reject before the engine ever throws', () => {
  test('/launch answers 400 from its pricing gate, not 500 from the throw', async () => {
    mockMissionRow = {
      id: 'm1', user_id: 'u1', goal_type: 'brand_lift', status: 'draft',
      respondent_count: 5, media_type: null, targeting: {}, questions: [],
    };
    const res = await request(app).post('/api/missions/launch').send({ missionId: 'm1' });
    expect(res.status).toBe(400);
    expect(mockCreatePaymentIntent).not.toHaveBeenCalled();
  });

  test('/payments/create-checkout-session answers 400, not 500', async () => {
    mockMissionRow = {
      id: 'm1', user_id: 'u1', goal_type: 'brand_lift', status: 'draft',
      respondent_count: 5, media_type: null, targeting: {}, questions: [],
    };
    const res = await request(app).post('/api/payments/create-checkout-session').send({ missionId: 'm1' });
    expect(res.status).toBe(400);
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });
});
