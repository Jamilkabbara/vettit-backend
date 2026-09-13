/**
 * ai_spend_ceiling_usd must come from the LIST price on every path.
 *
 * THE DEFECT
 * `ai_spend_ceiling_usd` is the only cost governor the mission pipeline has.
 * Three paths wrote it and they disagreed about what to base it on:
 *
 *   POST /api/payments/free-launch          no-promo list quote   (correct)
 *   POST /api/payments/create-checkout-session   POST-PROMO total (wrong)
 *   POST /api/missions                      server list price     (correct)
 *
 * plus a fourth writer nobody had counted, one layer down: POST
 * /api/missions/:id/launch writes total_price_usd and no ceiling at all, so
 * the pass-51 `ensure_recruitment_columns` trigger derived one from
 * total_price_usd - the post-promo total again.
 *
 * Consequence: a mission bought with a 50%-off code got HALF the spend ceiling
 * of an identical full-price mission, for identical work. Same respondent
 * count, same recruit loop, same model calls. The ceiling governs COMPUTE, not
 * revenue, so it must not move with a discount.
 *
 * WHAT THIS SUITE PINS, AND WHY IT IS SHAPED THIS WAY
 * Each money path gets its OWN named test asserting its OWN ceiling, so
 * reverting any single path to a post-promo basis fails a test that names that
 * path. A suite that only checked "all paths agree" would pass if every path
 * regressed together, which is exactly the state this PR found.
 *
 * The worked example the owner will live-check after deploy:
 *   50 respondents, goal `validate`, no targeting, no extra questions
 *     list price               $75
 *     charged with HALFOFF     $37
 *     ai_spend_ceiling_usd     $22.50   with the code AND without it
 *   The old basis produced $11.10 with the code - a 51% cut in compute budget
 *   for a mission doing 100% of the work.
 */
const express = require('express');
const request = require('supertest');
const fs = require('fs');
const path = require('path');

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'u1@test.dev' }; next(); },
  optionalAuthenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'u1@test.dev' }; next(); },
}));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

jest.mock('../src/services/stripe', () => ({
  createCheckoutSession: jest.fn(async () => ({ id: 'cs_1', url: 'https://stripe.test/cs_1', paymentIntentId: 'pi_1' })),
  createPaymentIntent:   jest.fn(async () => ({ clientSecret: 'cs_secret', paymentIntentId: 'pi_1' })),
  createPromoOnStripe:   jest.fn(),
  updateStripePromoActive: jest.fn(),
}));

const mockRunMission = jest.fn(async () => ({}));
jest.mock('../src/jobs/runMission', () => ({ runMission: mockRunMission }));

const mockUpdateMission = jest.fn(async () => ({}));
jest.mock('../src/db/missionSchema', () => {
  const actual = jest.requireActual('../src/db/missionSchema');
  return { ...actual, updateMission: mockUpdateMission };
});

jest.mock('../src/services/payments/confirmCheckoutSession', () => ({
  confirmCheckoutSessionPaid: jest.fn(async () => ({})),
}));
jest.mock('../src/services/promo/promoCodes', () => {
  const actual = jest.requireActual('../src/services/promo/promoCodes');
  return {
    ...actual,
    recordFreeLaunchRedemption: jest.fn(async () => ({ claimed: true })),
    releasePromoUse: jest.fn(async () => ({})),
  };
});

let mockMissionRow = null;
let mockPromo = null;
let mockInsertRow = null;

jest.mock('../src/db/supabase', () => {
  const makeChain = (table) => {
    const resolved = () => (table === 'promo_codes'
      ? { data: mockPromo, error: mockPromo ? null : { message: 'not found' } }
      : { data: mockMissionRow, error: mockMissionRow ? null : { message: 'not found' } });
    const chain = {
      select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
      update: () => chain,
      insert: (row) => { if (table === 'missions') mockInsertRow = row; return chain; },
      single: async () => (table === 'missions' && mockInsertRow
        ? { data: { id: 'm-new', ...mockInsertRow }, error: null }
        : resolved()),
      maybeSingle: async () => resolved(),
      then: (onF, onR) => Promise.resolve(resolved()).then(onF, onR),
    };
    return chain;
  };
  return {
    from: (table) => makeChain(table),
    storage: { from: () => ({
      createSignedUrl: async () => ({ data: null, error: { message: 'no object' } }),
      info: async () => ({ data: null, error: { message: 'no object' } }),
      getPublicUrl: () => ({ data: { publicUrl: null } }),
    }) },
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'u1@test.dev' } } }) } },
  };
});

const {
  calculateMissionPrice, aiSpendCeilingUsd, listPriceUsd, AI_SPEND_CEILING_FRACTION,
} = require('../src/utils/pricingEngine');

const app = express();
app.use(express.json());
app.use('/api/payments', require('../src/routes/payments'));
app.use('/api/missions', require('../src/routes/missions'));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

// ── The worked example, spelled out rather than computed by the test ────────
//
// Hard numbers on purpose. A test that recomputes its expectation with the
// same helper the route uses cannot tell a right answer from a wrong one that
// both sides agree on. These are the numbers the owner checks in production.
const N = 50;
const LIST_TOTAL_USD     = 75;    // 50 respondents on the `validate` ladder
const CHARGED_WITH_HALF  = 37;    // after HALFOFF
const LIST_CEILING_USD   = 22.5;  // 30% of $75 - what every path must write
const POST_PROMO_CEILING = 11.1;  // 30% of $37 - the bug, named so it can be
                                  // asserted AGAINST rather than just absent

const HALF_OFF = {
  code: 'HALFOFF', active: true, type: 'percentage', value: 50,
  expires_at: null, max_uses: null, uses_count: 0,
};
const FREE_PROMO = {
  code: 'FREELAUNCH', active: true, type: 'free',
  expires_at: null, max_uses: null, uses_count: 0,
};

const mission = (over) => ({
  id: 'm1', user_id: 'u1', status: 'draft', goal_type: 'validate',
  respondent_count: N, media_type: null, targeting: {}, questions: [],
  brief_attachment: null, target_audience: null, title: 'T', brief: 'B',
  ...over,
});

const tick = () => new Promise((r) => setImmediate(r));
const lastPatch = () => mockUpdateMission.mock.calls.at(-1)[2];

beforeEach(() => {
  mockUpdateMission.mockClear();
  mockRunMission.mockClear();
  mockMissionRow = null; mockPromo = null; mockInsertRow = null;
});

// ── Sanity: the fixture numbers are the ladder's numbers ────────────────────

describe('the worked example is real', () => {
  test('50 respondents list at $75 and charge $37 under a 50%-off code', () => {
    const inputs = {
      respondentCount: N, targeting: {}, questionCount: 0, countries: [], goalType: 'validate',
    };
    expect(calculateMissionPrice(inputs).total).toBe(LIST_TOTAL_USD);
    expect(calculateMissionPrice({ ...inputs, promoCode: HALF_OFF }).total).toBe(CHARGED_WITH_HALF);
    // and the two candidate bases are genuinely different, so every assertion
    // below is actually discriminating
    expect(LIST_CEILING_USD).not.toBe(POST_PROMO_CEILING);
    expect(LIST_CEILING_USD).toBe(LIST_TOTAL_USD * AI_SPEND_CEILING_FRACTION);
  });
});

// ── The helper ─────────────────────────────────────────────────────────────

describe('aiSpendCeilingUsd reads the list basis off a breakdown', () => {
  const inputs = {
    respondentCount: N, targeting: {}, questionCount: 0, countries: [], goalType: 'validate',
  };

  test('a discounted breakdown and a full-price one give the same ceiling', () => {
    const list = calculateMissionPrice(inputs);
    const half = calculateMissionPrice({ ...inputs, promoCode: HALF_OFF });
    const free = calculateMissionPrice({ ...inputs, promoCode: FREE_PROMO });

    expect(aiSpendCeilingUsd(list)).toBe(LIST_CEILING_USD);
    expect(aiSpendCeilingUsd(half)).toBe(LIST_CEILING_USD);
    expect(aiSpendCeilingUsd(free)).toBe(LIST_CEILING_USD);
    // a free mission must still get a POSITIVE budget or runMission refuses it
    expect(aiSpendCeilingUsd(free)).toBeGreaterThan(0);
  });

  test('listPriceUsd is promo-independent and equals the no-promo total', () => {
    const list = calculateMissionPrice(inputs);
    for (const promo of [undefined, HALF_OFF, FREE_PROMO, { code: 'TEN', active: true, type: 'flat', value: 10 }]) {
      expect(listPriceUsd(calculateMissionPrice({ ...inputs, promoCode: promo }))).toBe(list.total);
    }
  });

  test('the numeric form still works for callers that hold a list price', () => {
    expect(aiSpendCeilingUsd(LIST_TOTAL_USD)).toBe(LIST_CEILING_USD);
    expect(aiSpendCeilingUsd(0)).toBe(0);
    expect(aiSpendCeilingUsd(null)).toBe(0);
    expect(aiSpendCeilingUsd(undefined)).toBe(0);
    expect(aiSpendCeilingUsd('nonsense')).toBe(0);
  });

  test('an object with no usable subtotal authorises nothing', () => {
    expect(aiSpendCeilingUsd({})).toBe(0);
    expect(aiSpendCeilingUsd({ total: 999 })).toBe(0);   // total is not a basis
    expect(aiSpendCeilingUsd({ subtotal: 0 })).toBe(0);
    expect(aiSpendCeilingUsd({ subtotal: -5 })).toBe(0);
  });
});

// ── Path 1: create-checkout-session ────────────────────────────────────────

describe('POST /api/payments/create-checkout-session', () => {
  test('a 50%-off mission gets the FULL-PRICE ceiling', async () => {
    mockMissionRow = mission();
    mockPromo = HALF_OFF;

    const res = await request(app)
      .post('/api/payments/create-checkout-session')
      .send({ missionId: 'm1', promoCode: 'HALFOFF' });

    expect(res.status).toBe(200);
    expect(lastPatch().ai_spend_ceiling_usd).toBe(LIST_CEILING_USD);
    expect(lastPatch().ai_spend_ceiling_usd).not.toBe(POST_PROMO_CEILING);
    // the CHARGE still moves with the promo - this PR changes the ceiling only
    expect(lastPatch().total_price_usd).toBe(CHARGED_WITH_HALF);
    expect(lastPatch().target_qualified_count).toBe(N);
  });

  test('an identical full-price mission gets the SAME ceiling', async () => {
    mockMissionRow = mission();
    mockPromo = null;

    const res = await request(app)
      .post('/api/payments/create-checkout-session')
      .send({ missionId: 'm1' });

    expect(res.status).toBe(200);
    expect(lastPatch().ai_spend_ceiling_usd).toBe(LIST_CEILING_USD);
    expect(lastPatch().total_price_usd).toBe(LIST_TOTAL_USD);
  });
});

// ── Path 2: POST /api/missions/launch ──────────────────────────────────

describe('POST /api/missions/launch', () => {
  test('writes a list-basis ceiling instead of leaving it to the trigger', async () => {
    mockMissionRow = mission();
    mockPromo = HALF_OFF;

    const res = await request(app)
      .post('/api/missions/launch')
      .send({ missionId: 'm1', promoCode: 'HALFOFF' });

    expect(res.status).toBe(200);
    // It used to write NEITHER governor, which handed the ceiling to the
    // pass-51 trigger and its post-promo basis.
    expect(lastPatch().ai_spend_ceiling_usd).toBe(LIST_CEILING_USD);
    expect(lastPatch().ai_spend_ceiling_usd).not.toBe(POST_PROMO_CEILING);
    expect(lastPatch().target_qualified_count).toBe(N);
    expect(lastPatch().total_price_usd).toBe(CHARGED_WITH_HALF);
  });

  test('the same mission at full price gets the same ceiling', async () => {
    mockMissionRow = mission();
    mockPromo = null;

    const res = await request(app).post('/api/missions/launch').send({ missionId: 'm1' });

    expect(res.status).toBe(200);
    expect(lastPatch().ai_spend_ceiling_usd).toBe(LIST_CEILING_USD);
  });
});

// ── Path 3: free-launch ────────────────────────────────────────────────────

describe('POST /api/payments/free-launch', () => {
  test('a free mission gets the same ceiling as a paid one of the same size', async () => {
    mockMissionRow = mission();
    mockPromo = FREE_PROMO;

    const res = await request(app)
      .post('/api/payments/free-launch')
      .send({ missionId: 'm1', promoCode: 'FREELAUNCH' });
    await tick();

    expect(res.status).toBe(200);
    expect(lastPatch().ai_spend_ceiling_usd).toBe(LIST_CEILING_USD);
    expect(lastPatch().total_price_usd).toBe(0);   // charged nothing
    expect(lastPatch().ai_spend_ceiling_usd).toBeGreaterThan(0);
  });
});

// ── Path 4: POST /api/missions ─────────────────────────────────────────────

describe('POST /api/missions', () => {
  test('the created row carries the list-basis ceiling', async () => {
    const res = await request(app).post('/api/missions').send({
      goalType: 'validate', title: 'T', brief: 'B', respondentCount: N,
      questions: [], targeting: {},
    });

    expect(res.status).toBeLessThan(300);
    expect(mockInsertRow.ai_spend_ceiling_usd).toBe(LIST_CEILING_USD);
    expect(mockInsertRow.target_qualified_count).toBe(N);
  });
});

// ── The property the owner live-checks ─────────────────────────────────────

describe('THE PROPERTY: a discount never changes the compute budget', () => {
  const ceilingFromCheckout = async ({ promo }) => {
    mockUpdateMission.mockClear();
    mockMissionRow = mission();
    mockPromo = promo;
    await request(app)
      .post('/api/payments/create-checkout-session')
      .send({ missionId: 'm1', ...(promo ? { promoCode: promo.code } : {}) });
    return lastPatch().ai_spend_ceiling_usd;
  };

  test('50 respondents at $75 list: with and without HALFOFF, both ceilings are $22.50', async () => {
    const withCode    = await ceilingFromCheckout({ promo: HALF_OFF });
    const withoutCode = await ceilingFromCheckout({ promo: null });

    expect(withCode).toBe(withoutCode);
    expect(withCode).toBe(LIST_CEILING_USD);
  });

  test('a $10-flat code does not move it either', async () => {
    const flat = { code: 'TENOFF', active: true, type: 'flat', value: 10, expires_at: null, max_uses: null, uses_count: 0 };
    expect(await ceilingFromCheckout({ promo: flat })).toBe(LIST_CEILING_USD);
  });
});

// ── The call sites themselves ──────────────────────────────────────────────

describe('no writer passes a charged total to aiSpendCeilingUsd', () => {
  /**
   * A behavioural test can only catch a regression on a path where a promo
   * can actually be applied. POST /api/missions accepts no promo code, so on
   * that route `pricing.total` and the list price are the same number and no
   * assertion about a written row can tell them apart - reverting it to
   * `aiSpendCeilingUsd(pricing.total)` is invisible to every test above.
   *
   * It would not be invisible for long. The moment that route learns about
   * promo codes it would be the checkout bug again, already shipped. So the
   * call SHAPE is pinned directly: every writer hands over the whole
   * breakdown, and the helper picks the basis. Handing it a bare `.total`,
   * `.exactTotal` or `.totalCents` is the mistake this PR exists to undo, and
   * it fails here whatever route it appears on.
   */
  const SRC = path.join(__dirname, '..', 'src');

  const jsFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return jsFiles(full);
    return e.isFile() && e.name.endsWith('.js') ? [full] : [];
  });

  test('every aiSpendCeilingUsd call in src/ passes a breakdown, not a total', () => {
    const offenders = [];
    let callSites = 0;

    for (const file of jsFiles(SRC)) {
      // Comments are stripped first: the routes DESCRIBE the old
      // `aiSpendCeilingUsd(pricing.total)` call in prose so a reader knows what
      // changed, and prose is not a call site.
      const src = fs.readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      for (const m of src.matchAll(/aiSpendCeilingUsd\(([^)]*)\)/g)) {
        const arg = m[1].trim();
        if (!arg) continue;                       // the declaration itself
        callSites += 1;
        if (/\.(total|totalCents|exactTotal|discount)\b/.test(arg)) {
          offenders.push(`${path.relative(SRC, file)}: aiSpendCeilingUsd(${arg})`);
        }
      }
    }

    expect(callSites).toBeGreaterThanOrEqual(5);   // the writers this PR aligned
    expect(offenders).toEqual([]);
  });
});

// ── The layer under the routes ─────────────────────────────────────────────

describe('the ensure_recruitment_columns trigger agrees about the basis', () => {
  const PASS51 = path.join(__dirname, '..', 'migrations', 'pass-51',
    '02_ensure_recruitment_columns_update_recompute.sql');
  const PASS54 = path.join(__dirname, '..', 'migrations', 'pass-54',
    '01_ensure_recruitment_columns_list_price_basis.sql');

  const body = (file) => {
    const sql = fs.readFileSync(file, 'utf8').replace(/--[^\n]*/g, '');
    const m = sql.match(/RETURNS trigger AS \$\$([\s\S]*?)\$\$ LANGUAGE plpgsql/i);
    if (!m) throw new Error(`no plpgsql body in ${path.basename(file)}`);
    return m[1];
  };

  /** Every RHS assigned to ai_spend_ceiling_usd in the function body. */
  const ceilingAssignments = (src) =>
    [...src.matchAll(/ai_spend_ceiling_usd\s*:=\s*([^;]+);/gi)].map((m) => m[1]);

  test('the shipped pass-51 function is on the POST-PROMO basis (the defect, pinned)', () => {
    const rhs = ceilingAssignments(body(PASS51));
    expect(rhs.length).toBeGreaterThan(0);
    // total_price_usd with no discount_usd anywhere near it: the charge.
    expect(rhs.every((r) => /total_price_usd/.test(r) && !/discount_usd/.test(r))).toBe(true);
  });

  test('pass-54 derives every ceiling from the LIST basis, never the charge alone', () => {
    const rhs = ceilingAssignments(body(PASS54));
    expect(rhs.length).toBeGreaterThan(0);
    for (const r of rhs) {
      expect(r).toMatch(/total_price_usd/);
      // total_price_usd + discount_usd - the charge plus what came off it
      expect(r).toMatch(/discount_usd/);
    }
  });

  test('pass-54 stops the UPDATE branch clobbering a ceiling the route supplied', () => {
    const src = body(PASS54);
    const update = src.slice(src.search(/\bELSE\b/i));
    expect(update).toMatch(/ai_spend_ceiling_usd\s+IS\s+DISTINCT\s+FROM\s+OLD\.ai_spend_ceiling_usd/i);
  });

  test('the 30% fraction is the same number the application uses', () => {
    expect(body(PASS54)).toMatch(new RegExp(`\\*\\s*${AI_SPEND_CEILING_FRACTION}`));
  });
});
