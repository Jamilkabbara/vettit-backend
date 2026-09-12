/**
 * POST /api/missions - the setup payload goes in, the server-owned columns
 * come out DERIVED.
 *
 * WHAT THIS PHASE IS
 * The browser creates mission rows directly with supabase-js under RLS
 * (MissionSetupPage.tsx and CreativeAttentionPage.tsx in the frontend repo).
 * The RLS INSERT policy blocks status, paid_at, paid_amount_cents, promo_code
 * and ai_spend_usd_actual - and nothing else. So the browser today writes
 * media_type (the $19-vs-$49 switch), tier, price_estimated, mission_assets,
 * wave_config, ai_spend_ceiling_usd (the cap on what a run may spend) and
 * target_qualified_count (how many respondents a run chases). All seven are in
 * SERVER_OWNED_COLUMNS.
 *
 * This route now accepts the SAME payload those two pages send and works those
 * seven out for itself. The route carries no traffic yet; that is a later
 * phase. These tests are what makes it safe to point traffic at.
 *
 * WHAT THE TWO HALVES PROVE
 *   1. PARITY, one case per live methodology. Everything the page writes that
 *      the CUSTOMER owns survives the trip through the route unchanged. If it
 *      did not, moving a page onto this route would quietly drop a methodology
 *      block - which is exactly the bug Pass 47 fixed for naming_* alone.
 *   2. IGNORED, one case per server-owned column. A request that ASKS for a
 *      value gets the derived one. The sharp version: body says
 *      media_type=image, stored object is an mp4, row ends up 'video'.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'owner@test.dev' }; next(); },
  optionalAuthenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'owner@test.dev' }; next(); },
}));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/services/stripe', () => ({ createCheckoutSession: jest.fn(), createPromoOnStripe: jest.fn(), updateStripePromoActive: jest.fn() }));
jest.mock('../src/jobs/runMission', () => ({ runMission: jest.fn() }));
jest.mock('../src/services/ai/insights', () => ({ synthesizeInsights: jest.fn(), aggregate: jest.fn() }));
// Pass the patch through untouched so the assertions are on what the ROUTE
// built, not on what the schema guard let through. The guard has its own test.
jest.mock('../src/db/missionSchema', () => ({
  updateMission: jest.fn(async () => ({})),
  sanitizeMissionPatch: (p) => ({ patch: p, rejected: [] }),
  sanitizeClientMissionPatch: (p) => ({ patch: p, rejected: [] }),
}));

// ── The stored objects ──────────────────────────────────────────────────────
// Real heads, the same two the media-derivation test uses:
//   vett-creatives/.../vid35.mp4 -> 00 00 00 20 66 74 79 70 69 73 6f 6d ...
//   vett-creatives/.../img_1.jpg -> ff d8 ff e1 00 de 45 78 69 66 00 00 ...
const head = (hex) => { const b = Buffer.alloc(64); Buffer.from(hex, 'hex').copy(b); return b; };
const MP4_HEAD  = head('000000206674797069736f6d00000200');
const JPEG_HEAD = head('ffd8ffe100de457869660000');

// What the object at each storage path REALLY is. Keyed by path so one request
// can carry a creative and an asset that disagree with each other.
let mockStoredHeads = {};
let mockStoredInfo = {};

jest.mock('../src/db/supabase', () => {
  const makeChain = () => {
    const chain = {
      select: () => chain, eq: () => chain, order: () => chain, limit: () => chain, update: () => chain,
      insert: (row) => { global.__lastInsert = Array.isArray(row) ? row[0] : row; return chain; },
      single: async () => ({ data: { id: 'm-new', ...(global.__lastInsert || {}) }, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (onF, onR) => Promise.resolve({ data: { id: 'm-new', ...(global.__lastInsert || {}) }, error: null }).then(onF, onR),
    };
    return chain;
  };
  return {
    from: () => makeChain(),
    storage: {
      from: (bucket) => ({
        createSignedUrl: async (path) => ({ data: { signedUrl: `https://storage.test/${bucket}/${path}` }, error: null }),
        info: async (path) => (global.__storedInfo[path]
          ? { data: global.__storedInfo[path], error: null }
          : { data: null, error: { message: 'not found' } }),
        getPublicUrl: (path) => ({ data: { publicUrl: `https://storage.test/public/${bucket}/${path}` } }),
      }),
    },
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'owner@test.dev' } } }) } },
  };
});

global.fetch = jest.fn(async (url) => {
  const path = String(url).split('/').slice(4).join('/');
  const buf = global.__storedHeads[path];
  if (!buf) throw new Error('object not found');
  return { ok: true, status: 206, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
});

const app = express();
app.use(express.json());
app.use('/api/missions', require('../src/routes/missions'));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

const { calculateMissionPrice, aiSpendCeilingUsd, resolveTier, CREATIVE_ATTENTION_TIERS } =
  require('../src/utils/pricingEngine');

/** The flat per-creative price, read off the ladder rather than hardcoded. */
const caPrice = (id) => CREATIVE_ATTENTION_TIERS.find((t) => t.id === id).packagePrice;
const { COMING_SOON_GOAL_TYPES } = require('../src/config/comingSoon');

beforeEach(() => {
  global.__lastInsert = null;
  global.__storedHeads = mockStoredHeads = {};
  global.__storedInfo = mockStoredInfo = {};
});

const post = (body) => request(app).post('/api/missions').send(body);

/**
 * The columns each page's direct INSERT writes that the CUSTOMER owns, paired
 * with the request body that should reproduce them. Transcribed from
 * MissionSetupPage.tsx (the twelve methodology blocks plus brand_lift) and
 * CreativeAttentionPage.tsx.
 *
 * `client` is the parity assertion: every one of these must come out of the
 * route byte-identical. `body` is what a caller sends. Where the two differ it
 * is only in SPELLING - half the cases deliberately use camelCase so the
 * `namingCandidates ?? naming_candidates` contract is exercised on real
 * payloads and not just on one field.
 */
const METHODOLOGIES = [
  {
    goal: 'validate',
    body: {
      goalType: 'validate', brief: 'Will people buy a reusable coffee pod?',
      respondentCount: 50, targetAudience: 'UK coffee drinkers 25-45',
      brandName: 'PodAgain', category: 'beverages',
      audienceDescription: 'Daily espresso drinkers',
      competitorBrands: ['Nespresso', 'Lavazza'],
      conceptDescription: 'A steel pod you refill at home',
      conceptMediaUrl: 'https://cdn.test/pod.png',
      conceptMediaType: 'image',
      conceptPriceUsd: 24.99,
      conceptUseOccasion: 'weekday morning',
      validateMethodology: 'concept_test',
    },
    client: {
      brief: 'Will people buy a reusable coffee pod?', goal_type: 'validate',
      respondent_count: 50, target_audience: 'UK coffee drinkers 25-45',
      brand_name: 'PodAgain', category: 'beverages',
      audience_description: 'Daily espresso drinkers',
      competitor_brands: ['Nespresso', 'Lavazza'],
      concept_description: 'A steel pod you refill at home',
      concept_media_url: 'https://cdn.test/pod.png',
      concept_media_type: 'image', concept_price_usd: 24.99,
      concept_use_occasion: 'weekday morning', validate_methodology: 'concept_test',
    },
  },
  {
    goal: 'compare',
    body: {
      goalType: 'compare', brief: 'Which of these three packs wins?', respondentCount: 75,
      brand_name: 'PodAgain',
      concepts: [
        { id: 'c1', name: 'Slate', description: 'Matte dark', price_usd: 24 },
        { id: 'c2', name: 'Ivory', description: 'Warm light', price_usd: 24 },
      ],
      comparison_methodology: 'sequential_monadic',
      rotation_strategy: 'random',
    },
    client: {
      goal_type: 'compare', respondent_count: 75, brand_name: 'PodAgain',
      concepts: [
        { id: 'c1', name: 'Slate', description: 'Matte dark', price_usd: 24 },
        { id: 'c2', name: 'Ivory', description: 'Warm light', price_usd: 24 },
      ],
      comparison_methodology: 'sequential_monadic', rotation_strategy: 'random',
    },
  },
  {
    goal: 'marketing',
    body: {
      goalType: 'marketing', brief: 'Does the launch ad land?', respondentCount: 60,
      creativeMediaUrl: 'https://cdn.test/ad.mp4', creativeMediaType: 'video',
      campaignChannel: 'instagram', campaignFormat: 'reel', campaignObjective: 'awareness',
      intendedMessage: 'Refill, do not rebuy', adMethodology: 'ad_effectiveness',
    },
    client: {
      goal_type: 'marketing', respondent_count: 60,
      creative_media_url: 'https://cdn.test/ad.mp4', creative_media_type: 'video',
      campaign_channel: 'instagram', campaign_format: 'reel', campaign_objective: 'awareness',
      intended_message: 'Refill, do not rebuy', ad_methodology: 'ad_effectiveness',
    },
  },
  {
    goal: 'satisfaction',
    body: {
      goalType: 'satisfaction', brief: 'How is onboarding landing?', respondentCount: 40,
      csat_touchpoint: 'custom', csat_custom_touchpoint: 'first refill order',
      csat_customer_type: 'new', csat_recency_window: '30d', csat_methodology: 'nps_csat_ces',
    },
    client: {
      goal_type: 'satisfaction', respondent_count: 40,
      csat_touchpoint: 'custom', csat_custom_touchpoint: 'first refill order',
      csat_customer_type: 'new', csat_recency_window: '30d', csat_methodology: 'nps_csat_ces',
    },
  },
  {
    goal: 'pricing',
    body: {
      goalType: 'pricing', brief: 'What will they pay for a refill pack?', respondentCount: 120,
      pricingProductDescription: 'A 30-pod refill pack', pricingCurrency: 'GBP',
      pricingModel: 'one_off', pricingContext: 'sold on our own site',
      pricingExpectedMin: 8, pricingExpectedMax: 22,
      pricingMethodology: 'van_westendorp_plus_gabor_granger',
    },
    client: {
      goal_type: 'pricing', respondent_count: 120,
      pricing_product_description: 'A 30-pod refill pack', pricing_currency: 'GBP',
      pricing_model: 'one_off', pricing_context: 'sold on our own site',
      pricing_expected_min: 8, pricing_expected_max: 22,
      pricing_methodology: 'van_westendorp_plus_gabor_granger',
    },
  },
  {
    goal: 'roadmap',
    body: {
      goalType: 'roadmap', brief: 'Which features next?', respondentCount: 80,
      roadmapFeatures: [{ id: 'f1', name: 'Auto-reorder' }, { id: 'f2', name: 'Gift packs' }],
      roadmapMethodology: 'max_diff_plus_kano',
    },
    client: {
      goal_type: 'roadmap', respondent_count: 80,
      roadmap_features: [{ id: 'f1', name: 'Auto-reorder' }, { id: 'f2', name: 'Gift packs' }],
      roadmap_methodology: 'max_diff_plus_kano',
    },
  },
  {
    goal: 'research',
    body: {
      goalType: 'research', brief: 'How do people actually make coffee at home?',
      respondentCount: 50, questions: [{ id: 'q1', text: 'Walk me through your morning' }],
      targeting: { geography: { cities: ['London'] } },
      brandName: 'PodAgain', category: 'beverages',
    },
    client: {
      goal_type: 'research', respondent_count: 50,
      questions: [{ id: 'q1', text: 'Walk me through your morning' }],
      targeting: { geography: { cities: ['London'] } },
      brand_name: 'PodAgain', category: 'beverages',
    },
  },
  {
    goal: 'competitor',
    body: {
      goalType: 'competitor', brief: 'Benchmark us against the rivals', respondentCount: 90,
      brand_name: 'PodAgain', competitor_brands: ['Nespresso', 'Lavazza'],
      attribute_battery: ['taste', 'price', 'sustainability'],
      competitor_methodology: 'brand_health_tracker',
    },
    client: {
      goal_type: 'competitor', respondent_count: 90, brand_name: 'PodAgain',
      competitor_brands: ['Nespresso', 'Lavazza'],
      attribute_battery: ['taste', 'price', 'sustainability'],
      competitor_methodology: 'brand_health_tracker',
    },
  },
  {
    goal: 'audience_profiling',
    body: {
      goalType: 'audience_profiling', brief: 'Who actually buys refills?', respondentCount: 200,
      brandName: 'PodAgain', audienceDescription: 'Existing customers',
      targetAudience: 'UK, has ordered in the last 6 months',
    },
    client: {
      goal_type: 'audience_profiling', respondent_count: 200, brand_name: 'PodAgain',
      audience_description: 'Existing customers',
      target_audience: 'UK, has ordered in the last 6 months',
    },
  },
  {
    goal: 'naming_messaging',
    body: {
      goalType: 'naming_messaging', brief: 'Pick the name', respondentCount: 65,
      namingTestType: 'monadic',
      namingCandidates: [{ id: 'n1', name: 'Lumio' }, { id: 'n2', name: 'Vantage' }],
      namingCriteria: ['memorable', 'easy to say'],
      namingMethodology: 'monadic_plus_paired',
      brandPersonality: 'warm, plain-spoken',
    },
    client: {
      goal_type: 'naming_messaging', respondent_count: 65, naming_test_type: 'monadic',
      naming_candidates: [{ id: 'n1', name: 'Lumio' }, { id: 'n2', name: 'Vantage' }],
      naming_criteria: ['memorable', 'easy to say'],
      naming_methodology: 'monadic_plus_paired', brand_personality: 'warm, plain-spoken',
    },
  },
  {
    goal: 'market_entry',
    body: {
      goalType: 'market_entry', brief: 'Where do we launch next?', respondentCount: 150,
      brandName: 'PodAgain', targetedMarkets: ['Germany', 'France', 'Spain'],
    },
    client: {
      goal_type: 'market_entry', respondent_count: 150, brand_name: 'PodAgain',
      // Server-owned column, but nothing prices off it for THIS goal, so it is
      // accepted in the request that also computes the price - exactly how
      // brand_lift's markets and channels are handled.
      targeted_markets: ['Germany', 'France', 'Spain'],
    },
  },
  {
    goal: 'churn_research',
    body: {
      goalType: 'churn_research', brief: 'Why do subscribers leave?', respondentCount: 110,
      churnDefinition: 'custom', churnCustomDefinition: 'no order in 90 days',
      churnCustomerType: 'subscriber', churnWinbackPossible: true,
      churnMethodology: 'driver_tree',
    },
    client: {
      goal_type: 'churn_research', respondent_count: 110,
      churn_definition: 'custom', churn_custom_definition: 'no order in 90 days',
      churn_customer_type: 'subscriber', churn_winback_possible: true,
      churn_methodology: 'driver_tree',
    },
  },
  {
    goal: 'brand_lift',
    body: {
      goalType: 'brand_lift', brief: 'Did the campaign move awareness?', respondentCount: 400,
      brandName: 'PodAgain',
      targetedMarkets: ['UK', 'DE'], campaignChannels: ['tv', 'youtube'],
      waveConfig: { mode: 'pre_post' },
      brandLiftTemplate: 'awareness_intent',
      brandLiftKpis: ['aided_awareness', 'purchase_intent'],
      creativeMetadata: { name: 'Autumn cut', durationSec: 30 },
      competitorBrands: ['Nespresso'],
    },
    client: {
      goal_type: 'brand_lift', respondent_count: 400, brand_name: 'PodAgain',
      targeted_markets: ['UK', 'DE'], campaign_channels: ['tv', 'youtube'],
      brand_lift_template: 'awareness_intent',
      brand_lift_kpis: ['aided_awareness', 'purchase_intent'],
      creative_metadata: { name: 'Autumn cut', durationSec: 30 },
      competitor_brands: ['Nespresso'],
    },
  },
];

// ── 1. Create parity, one case per live methodology ─────────────────────────

describe('POST /api/missions - parity with the Setup page insert', () => {
  test('every live goal_type has a parity case', () => {
    const covered = new Set([...METHODOLOGIES.map((m) => m.goal), 'creative_attention']);
    // The gate list is the authority on what is live. Anything not on it is a
    // methodology a customer can buy, so it needs a case here.
    for (const goal of COMING_SOON_GOAL_TYPES) covered.delete(goal);
    expect(covered.size).toBe(14 - COMING_SOON_GOAL_TYPES.length);
  });

  test.each(METHODOLOGIES.map((m) => [m.goal, m]))(
    '%s: every customer-owned column the page writes survives the route',
    async (_goal, m) => {
      const res = await post(m.body);
      expect(res.status).toBe(201);
      const row = global.__lastInsert;
      expect(row).not.toBeNull();
      for (const [col, val] of Object.entries(m.client)) {
        expect({ [col]: row[col] }).toEqual({ [col]: val });
      }
      // And the row is the customer's own.
      expect(row.user_id).toBe('u1');
      expect(row.status).toBe('draft');
    },
  );

  test.each(METHODOLOGIES.map((m) => [m.goal, m]))(
    '%s: the server-owned columns are the SERVER\'s numbers, not the body\'s',
    async (_goal, m) => {
      const res = await post(m.body);
      expect(res.status).toBe(201);
      const row = global.__lastInsert;

      // Same expression the route's own price path uses, recomputed here from
      // the engine rather than read back off the row.
      expect(row.price_estimated).toBe(row.total_price_usd);
      expect(row.target_qualified_count).toBe(m.body.respondentCount);
      expect(row.ai_spend_ceiling_usd).toBe(aiSpendCeilingUsd(row.total_price_usd));
      expect(row.tier).toBe(resolveTier({
        goalType: m.goal, respondentCount: m.body.respondentCount, mediaType: null,
      }).id);
      expect(row.mission_assets).toEqual([]);
      expect(row.recruitment_status).toBe('pending');
      // wave_config exists on brand_lift and nowhere else.
      if (m.goal === 'brand_lift') expect(row.wave_config).toEqual({ mode: 'pre_post' });
      else expect(row.wave_config).toBeUndefined();
    },
  );

  test('creative_attention: every column the Creative Attention page writes survives', async () => {
    mockStoredHeads['u1/1788950643888-img_1.jpg'] = JPEG_HEAD;
    const res = await post({
      goalType: 'creative_attention',
      title: 'Creative Attention: PodAgain',
      brief: 'Autumn hero still',
      respondentCount: 10,
      brandName: 'PodAgain',
      targetAudience: 'UK coffee drinkers',
      desiredEmotions: ['curious', 'warm'],
      keyMessage: 'Refill, do not rebuy',
      mediaUrl: 'https://cdn.test/img_1.jpg',
      briefAttachment: {
        path: 'u1/1788950643888-img_1.jpg',
        mimeType: 'image/jpeg', originalName: 'img_1.jpg', sizeBytes: 91234,
      },
    });
    expect(res.status).toBe(201);
    const row = global.__lastInsert;
    expect(row.title).toBe('Creative Attention: PodAgain');
    expect(row.brief).toBe('Autumn hero still');
    expect(row.goal_type).toBe('creative_attention');
    expect(row.respondent_count).toBe(10);
    expect(row.brand_name).toBe('PodAgain');
    expect(row.target_audience).toBe('UK coffee drinkers');
    expect(row.desired_emotions).toEqual(['curious', 'warm']);
    expect(row.key_message).toBe('Refill, do not rebuy');
    expect(row.media_url).toBe('https://cdn.test/img_1.jpg');
    expect(row.brief_attachment.path).toBe('u1/1788950643888-img_1.jpg');
    // Derived, not echoed: a real JPEG prices as an image.
    expect(row.media_type).toBe('image');
    expect(row.tier).toBe('image');
    expect(row.price_estimated).toBe(caPrice('image'));
    expect(row.total_price_usd).toBe(caPrice('image'));
  });
});

// ── 2. A client-supplied value for a server-owned column is IGNORED ─────────

describe('POST /api/missions - server-owned columns cannot be set from the body', () => {
  /**
   * The heart of the phase. The request says image over an mp4.
   *
   * This is not a hypothetical: it is the $19-for-$49-of-work hole. The
   * analysis pipeline branches on the stored file, not on this column, so a
   * row saying "image" over a video still buys the full 30-frame vision run.
   */
  test('media_type: body says image, the stored object is a video, the row is video', async () => {
    mockStoredHeads['u1/1788944318217-vid35.mp4'] = MP4_HEAD;
    const res = await post({
      goalType: 'creative_attention', brief: 'Autumn cut', respondentCount: 10,
      brandName: 'PodAgain',
      mediaType: 'image',                 // the lie
      media_type: 'image',                // and the same lie in snake_case
      briefAttachment: {
        path: 'u1/1788944318217-vid35.mp4',
        mimeType: 'image/jpeg',           // and a matching lie in the attachment
        originalName: 'vid35.jpg',
      },
    });
    expect(res.status).toBe(201);
    const row = global.__lastInsert;
    expect(row.media_type).toBe('video');
    expect(row.tier).toBe('video');
    // And the price follows the bytes, not the claim.
    expect(row.total_price_usd).toBe(caPrice('video'));
    expect(row.price_estimated).toBe(caPrice('video'));
  });

  test('media_type: an object that cannot be read leaves the column NULL, never the claim', async () => {
    // Nothing registered at the path, so the byte read throws and .info misses.
    const res = await post({
      goalType: 'creative_attention', brief: 'Autumn cut', respondentCount: 10,
      brandName: 'PodAgain', mediaType: 'video',
      briefAttachment: { path: 'u1/gone.bin', mimeType: 'video/mp4' },
    });
    expect(res.status).toBe(201);
    const row = global.__lastInsert;
    // NOT 'video'. An unanswered question is not a verdict, and the claim is
    // not the fallback - create-checkout-session re-derives and fills it in.
    expect(row.media_type).toBeUndefined();
  });

  test('media_type: falls back to the storage-recorded content type, still not to the body', async () => {
    mockStoredInfo['u1/opaque.bin'] = { contentType: 'video/quicktime', size: 4096 };
    const res = await post({
      goalType: 'creative_attention', brief: 'Autumn cut', respondentCount: 10,
      brandName: 'PodAgain', mediaType: 'image',
      briefAttachment: { path: 'u1/opaque.bin', mimeType: 'image/png' },
    });
    expect(res.status).toBe(201);
    expect(global.__lastInsert.media_type).toBe('video');
  });

  test('tier: a body-supplied tier is dropped; resolveTier decides', async () => {
    const res = await post({
      goalType: 'validate', brief: 'Concept read', respondentCount: 50,
      tier: 'enterprise', // a tier that would price this at something else
    });
    expect(res.status).toBe(201);
    const expected = resolveTier({ goalType: 'validate', respondentCount: 50, mediaType: null });
    expect(global.__lastInsert.tier).toBe(expected.id);
    expect(global.__lastInsert.tier).not.toBe('enterprise');
  });

  test('price_estimated: the body cannot set the number the dashboard shows', async () => {
    const res = await post({
      goalType: 'validate', brief: 'Concept read', respondentCount: 50,
      priceEstimated: 1, price_estimated: 1,
    });
    expect(res.status).toBe(201);
    const row = global.__lastInsert;
    expect(row.price_estimated).not.toBe(1);
    expect(row.price_estimated).toBe(row.total_price_usd);
  });

  test('ai_spend_ceiling_usd: the body cannot authorise its own AI spend', async () => {
    const res = await post({
      goalType: 'validate', brief: 'Concept read', respondentCount: 50,
      aiSpendCeilingUsd: 5000, ai_spend_ceiling_usd: 5000,
    });
    expect(res.status).toBe(201);
    const row = global.__lastInsert;
    expect(row.ai_spend_ceiling_usd).not.toBe(5000);
    expect(row.ai_spend_ceiling_usd).toBe(aiSpendCeilingUsd(row.total_price_usd));
  });

  test('target_qualified_count: the body cannot ask for more delivery than it paid for', async () => {
    const res = await post({
      goalType: 'validate', brief: 'Concept read', respondentCount: 50,
      targetQualifiedCount: 9999, target_qualified_count: 9999,
    });
    expect(res.status).toBe(201);
    const row = global.__lastInsert;
    expect(row.target_qualified_count).toBe(50);
    expect(row.target_qualified_count).toBe(row.respondent_count);
  });

  test('mission_assets: the record is built from storage, not from what the body claimed', async () => {
    mockStoredHeads['u1/999-clip.mp4'] = MP4_HEAD;
    mockStoredInfo['u1/999-clip.mp4'] = { contentType: 'video/mp4', size: 2_600_000 };
    const res = await post({
      goalType: 'marketing', brief: 'Does the ad land?', respondentCount: 60,
      missionAssets: [{
        path: 'u1/999-clip.mp4',
        // Every one of these is a claim about the file and every one is wrong.
        url: 'https://evil.test/somewhere-else.png',
        type: 'image',
        filename: 'totally-a-picture.png',
        mimeType: 'image/png',
        sizeBytes: 12,
        uploadedAt: '1999-01-01T00:00:00.000Z',
      }],
    });
    expect(res.status).toBe(201);
    const [asset] = global.__lastInsert.mission_assets;
    expect(asset.path).toBe('u1/999-clip.mp4');
    expect(asset.type).toBe('video');                       // bytes, not the claim
    expect(asset.url).toBe('https://storage.test/public/vettit-uploads/u1/999-clip.mp4');
    expect(asset.url).not.toContain('evil.test');           // server composes the URL
    expect(asset.filename).toBe('999-clip.mp4');            // storage path, not originalName
    expect(asset.mimeType).toBe('video/mp4');               // storage, not the claim
    expect(asset.sizeBytes).toBe(2_600_000);                // storage, not 12
    expect(new Date(asset.uploadedAt).getFullYear()).toBeGreaterThan(2000);
  });

  test('mission_assets: an unreadable object is recorded as unknown, never as the claimed type', async () => {
    const res = await post({
      goalType: 'marketing', brief: 'Does the ad land?', respondentCount: 60,
      missionAssets: [{ path: 'u1/missing.bin', type: 'image', mimeType: 'image/png' }],
    });
    expect(res.status).toBe(201);
    const [asset] = global.__lastInsert.mission_assets;
    expect(asset.type).toBeNull();
    expect(asset.mimeType).toBeNull();
  });

  test('wave_config: an arbitrary blob is refused; the column gets { mode } and nothing else', async () => {
    const res = await post({
      goalType: 'brand_lift', brief: 'Campaign read', respondentCount: 400,
      targetedMarkets: ['UK'], campaignChannels: ['tv'],
      waveConfig: {
        mode: 'every_hour_forever',                 // not one of the three
        campaignStart: '2026-01-01',                // a field the column does not have
        notes: 'x'.repeat(4096),                    // and 4 kB of it
      },
    });
    expect(res.status).toBe(201);
    expect(global.__lastInsert.wave_config).toEqual({ mode: 'single_wave' });
  });

  test('wave_config: a real mode is kept, and only on brand_lift', async () => {
    const bl = await post({
      goalType: 'brand_lift', brief: 'Campaign read', respondentCount: 400,
      targetedMarkets: ['UK'], campaignChannels: ['tv'], waveConfig: { mode: 'continuous' },
    });
    expect(bl.status).toBe(201);
    expect(global.__lastInsert.wave_config).toEqual({ mode: 'continuous' });

    const other = await post({
      goalType: 'validate', brief: 'Concept read', respondentCount: 50,
      waveConfig: { mode: 'continuous' },
    });
    expect(other.status).toBe(201);
    expect(global.__lastInsert.wave_config).toBeUndefined();
  });
});

// ── 3. The gates that were already there still fire ─────────────────────────

describe('POST /api/missions - the existing gates are unmoved', () => {
  test('a below-floor brand_lift is still refused, before any derivation runs', async () => {
    const res = await post({ goalType: 'brand_lift', brief: 'x', respondentCount: 5, targetedMarkets: ['UK'], campaignChannels: ['tv'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('min_respondents');
    expect(global.__lastInsert).toBeNull();
  });

  test('a below-floor creative_attention is still refused', async () => {
    mockStoredHeads['u1/x.jpg'] = JPEG_HEAD;
    const res = await post({
      goalType: 'creative_attention', brief: 'x', respondentCount: 3,
      briefAttachment: { path: 'u1/x.jpg' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('min_respondents');
    expect(global.__lastInsert).toBeNull();
  });

  test('a competitor study with no focal brand is still refused', async () => {
    const res = await post({ goalType: 'competitor', brief: 'x', respondentCount: 30 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('brand_required');
  });
});

// ── 4. The ceiling formula is ONE expression ────────────────────────────────

describe('aiSpendCeilingUsd - the 70% margin floor, in one place', () => {
  test('is 30% of the list price at 4dp', () => {
    expect(aiSpendCeilingUsd(99)).toBe(29.7);
    expect(aiSpendCeilingUsd(35)).toBe(10.5);
    expect(aiSpendCeilingUsd(19)).toBe(5.7);
  });

  test('a missing or non-positive price authorises nothing', () => {
    // runMission refuses a mission whose ceiling is not positive, which is the
    // correct outcome: no price, no run.
    expect(aiSpendCeilingUsd(null)).toBe(0);
    expect(aiSpendCeilingUsd(undefined)).toBe(0);
    expect(aiSpendCeilingUsd(0)).toBe(0);
    expect(aiSpendCeilingUsd(-10)).toBe(0);
  });

  test('matches what the route writes, computed independently from the engine', async () => {
    const res = await post({ goalType: 'validate', brief: 'Concept read', respondentCount: 250 });
    expect(res.status).toBe(201);
    const expected = calculateMissionPrice({
      respondentCount: 250, targeting: {}, questionCount: 0, countries: [], goalType: 'validate',
    });
    expect(global.__lastInsert.total_price_usd).toBe(expected.total);
    expect(global.__lastInsert.ai_spend_ceiling_usd).toBe(aiSpendCeilingUsd(expected.total));
  });
});
