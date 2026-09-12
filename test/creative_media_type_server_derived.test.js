/**
 * Residual 1 - media_type is a price, and the browser used to set it.
 *
 * THE DEFECT
 * Creative Attention bills $19 for an image and $49 for a video, and
 * missions.media_type picks between them. That column is written by the
 * browser on the client-side mission INSERT; the RLS INSERT policy blocks
 * status, paid_at, paid_amount_cents, promo_code and ai_spend_usd_actual, and
 * `authenticated` holds INSERT on media_type. Nothing server-side ever
 * compared it to the file that was uploaded.
 *
 * create-checkout-session LOOKED like it re-stamped the value. It wrote
 * `media_type: mission.media_type || null` - the row's own value copied back
 * onto the row, which verifies nothing. validateMissionPricing and
 * paymentCoversRun then both read the same unverified column.
 *
 * The analysis pipeline never reads media_type at all: analyzeCreative
 * branches on the stored file, so a row saying "image" over an uploaded mp4
 * still got the full 30-frame video analysis - for $19.
 *
 * THE FIX, AND WHAT MUST STILL HOLD
 *   1. Every path that prices or charges Creative Attention derives the media
 *      type from the first bytes of the STORED OBJECT and refuses when that
 *      disagrees with the row.
 *   2. A genuine image mission still charges $19 and a genuine video mission
 *      still charges $49 - the derivation must not become a new way to fail.
 *   3. bundle and series price as stills, so they must NOT be read as a
 *      disagreement with an image file.
 *   4. An object we cannot read is an unanswered question, not a verdict: it
 *      must not block a legitimate purchase.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'u1@test.dev' }; next(); },
  optionalAuthenticate: (req, _res, next) => { req.user = { id: 'u1', email: 'u1@test.dev' }; next(); },
}));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockCreateCheckoutSession = jest.fn(async () => ({ id: 'cs_test', url: 'https://stripe.test/cs', paymentIntentId: 'pi_test' }));
const mockRetrievePaymentIntent = jest.fn(async () => ({ id: 'pi_test', amount_received: 1900 }));
jest.mock('../src/services/stripe', () => ({
  createCheckoutSession: mockCreateCheckoutSession,
  retrievePaymentIntent: (...a) => mockRetrievePaymentIntent(...a),
  createPromoOnStripe: jest.fn(), updateStripePromoActive: jest.fn(),
}));
jest.mock('../src/jobs/runMission', () => ({ runMission: jest.fn(async () => ({})) }));
const mockUpdateMission = jest.fn(async () => ({}));
jest.mock('../src/db/missionSchema', () => ({
  updateMission: mockUpdateMission,
  sanitizeMissionPatch: (p) => ({ patch: p, rejected: [] }),
  sanitizeClientMissionPatch: (p) => ({ patch: p, rejected: [] }),
  stampMissionHeartbeat: jest.fn(async () => ({})),
}));
jest.mock('../src/services/payments/confirmCheckoutSession', () => ({
  confirmCheckoutSessionPaid: jest.fn(async () => ({})),
}));

// ── The stored object ───────────────────────────────────────────────────────
// Real heads, copied from the two production creatives in vett-creatives:
//   .../1788944318217-vid35.mp4  -> 00 00 00 20 66 74 79 70 69 73 6f 6d ...
//   .../1788950643888-img_1.jpg  -> ff d8 ff e1 00 de 45 78 69 66 00 00 ...
const head = (hex) => {
  const b = Buffer.alloc(64);
  Buffer.from(hex, 'hex').copy(b);
  return b;
};
const MP4_HEAD  = head('000000206674797069736f6d00000200');
const JPEG_HEAD = head('ffd8ffe100de457869660000');
const WEBP_HEAD = head('52494646a0000000574542505650382000000000');
const HEIC_HEAD = head('0000001c6674797068656963000000006d696631');

let storedHead = JPEG_HEAD;      // what the object's first bytes really are
let storedContentType = null;    // what the Storage API recorded, if asked
let signFails = false;
let fetchFails = false;

const mockCreateSignedUrl = jest.fn(async () => (signFails
  ? { data: null, error: { message: 'object not found' } }
  : { data: { signedUrl: 'https://storage.test/signed' }, error: null }));
const mockInfo = jest.fn(async () => (storedContentType
  ? { data: { contentType: storedContentType }, error: null }
  : { data: null, error: { message: 'not found' } }));

let mockMissionRow = null;
let mockPromo = null;
jest.mock('../src/db/supabase', () => {
  const makeChain = (table) => {
    const resolved = () => ({ data: mockMissionRow, error: mockMissionRow ? null : { message: 'not found' } });
    const chain = {
      select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
      update: () => chain, insert: () => chain,
      single: async () => (table === 'promo_codes'
        ? { data: mockPromo, error: mockPromo ? null : { message: 'not found' } }
        : resolved()),
      maybeSingle: async () => (table === 'promo_codes' ? { data: mockPromo, error: null } : resolved()),
      then: (onF, onR) => Promise.resolve(resolved()).then(onF, onR),
    };
    return chain;
  };
  return {
    from: (table) => makeChain(table),
    storage: { from: () => ({ createSignedUrl: mockCreateSignedUrl, info: mockInfo }) },
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'u1@test.dev' } } }) } },
  };
});

global.fetch = jest.fn(async () => {
  if (fetchFails) throw new Error('network down');
  return {
    ok: true, status: 206,
    arrayBuffer: async () => storedHead.buffer.slice(storedHead.byteOffset, storedHead.byteOffset + storedHead.length),
  };
});

const { classifyMagicBytes, declaredPriceClass, verifyCreativeMediaType } =
  require('../src/services/media/creativeMediaType');
const { checkPaymentCoversRun } = require('../src/services/payments/paymentCoversRun');
const supabase = require('../src/db/supabase');

const app = express();
app.use(express.json());
app.use('/api/payments', require('../src/routes/payments'));
app.use('/api/missions', require('../src/routes/missions'));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

const ca = (over) => ({
  id: 'm1', user_id: 'u1', status: 'draft', goal_type: 'creative_attention',
  respondent_count: 10, media_type: 'image', targeting: {}, questions: [],
  brief_attachment: { path: 'u1/creative-attention/ad.jpg', mimeType: 'image/jpeg' },
  ...over,
});

const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  mockCreateCheckoutSession.mockClear();
  mockUpdateMission.mockClear();
  mockCreateSignedUrl.mockClear();
  mockInfo.mockClear();
  global.fetch.mockClear();
  mockMissionRow = null; mockPromo = null;
  storedHead = JPEG_HEAD; storedContentType = null;
  signFails = false; fetchFails = false;
});

// ── The classifier itself ───────────────────────────────────────────────────
describe('classifyMagicBytes tells a picture from a film', () => {
  test('mp4 (ISO-BMFF, isom brand) is video', () => {
    expect(classifyMagicBytes(MP4_HEAD).mediaType).toBe('video');
  });
  test('jpeg is image', () => {
    expect(classifyMagicBytes(JPEG_HEAD).mediaType).toBe('image');
  });
  test('webp is image, not an AVI, despite sharing the RIFF container', () => {
    expect(classifyMagicBytes(WEBP_HEAD).mediaType).toBe('image');
  });
  test('heic is image even though it carries an ftyp box like mp4 does', () => {
    expect(classifyMagicBytes(HEIC_HEAD).mediaType).toBe('image');
  });
  test('an unknown signature is null, never a guess', () => {
    expect(classifyMagicBytes(Buffer.alloc(64))).toBeNull();
  });
  test('bundle and series are the image price class, not their own', () => {
    expect(declaredPriceClass('bundle')).toBe('image');
    expect(declaredPriceClass('series')).toBe('image');
    expect(declaredPriceClass('video')).toBe('video');
    expect(declaredPriceClass(null)).toBeNull();
  });
});

// ── The verifier reads the object, never the row's own claims ───────────────
describe('verifyCreativeMediaType', () => {
  test('a row claiming image over an mp4 is a mismatch', async () => {
    storedHead = MP4_HEAD;
    const v = await verifyCreativeMediaType(supabase, ca());
    expect(v).toMatchObject({ checked: true, mismatch: true, declared: 'image', derived: 'video', source: 'magic_bytes' });
  });

  test('the client-written mimeType is ignored - only the bytes decide', async () => {
    // brief_attachment.mimeType says image/jpeg AND media_type says image.
    // The client was internally consistent; the file is still an mp4.
    storedHead = MP4_HEAD;
    const v = await verifyCreativeMediaType(supabase, ca({
      brief_attachment: { path: 'u1/creative-attention/ad.jpg', mimeType: 'image/jpeg' },
    }));
    expect(v.derived).toBe('video');
    expect(v.mismatch).toBe(true);
  });

  test('an unreadable object answers "not checked", never "fine"', async () => {
    signFails = true;
    const v = await verifyCreativeMediaType(supabase, ca());
    expect(v.checked).toBe(false);
    expect(v.mismatch).toBe(false);
    expect(v.source).toBe('unverifiable');
  });

  test('when the bytes cannot be read the storage-recorded content type answers', async () => {
    fetchFails = true; storedContentType = 'video/mp4';
    const v = await verifyCreativeMediaType(supabase, ca());
    expect(v).toMatchObject({ checked: true, derived: 'video', source: 'storage_content_type', mismatch: true });
  });

  test('a non-creative_attention mission is not checked at all', async () => {
    const v = await verifyCreativeMediaType(supabase, ca({ goal_type: 'validate' }));
    expect(v.checked).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ── create-checkout-session ─────────────────────────────────────────────────
describe('create-checkout-session prices from the stored object', () => {
  test('row says image, object is an mp4 -> refused, Stripe never called', async () => {
    mockMissionRow = ca({ media_type: 'image' });
    storedHead = MP4_HEAD;
    const res = await request(app).post('/api/payments/create-checkout-session').send({ missionId: 'm1' });

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('media_type_mismatch');
    expect(res.body).toMatchObject({ declared: 'image', detected: 'video' });
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    expect(mockUpdateMission).not.toHaveBeenCalled();
  });

  test('POSITIVE CONTROL: a genuine image mission still charges $19', async () => {
    mockMissionRow = ca({ media_type: 'image' });
    storedHead = JPEG_HEAD;
    const res = await request(app).post('/api/payments/create-checkout-session').send({ missionId: 'm1' });

    expect(res.status).toBe(200);
    expect(mockCreateCheckoutSession).toHaveBeenCalledTimes(1);
    expect(mockCreateCheckoutSession.mock.calls[0][0].amountCents).toBe(1900);
  });

  test('POSITIVE CONTROL: a genuine video mission still charges $49', async () => {
    mockMissionRow = ca({ media_type: 'video', brief_attachment: { path: 'u1/creative-attention/ad.mp4' } });
    storedHead = MP4_HEAD;
    const res = await request(app).post('/api/payments/create-checkout-session').send({ missionId: 'm1' });

    expect(res.status).toBe(200);
    expect(mockCreateCheckoutSession.mock.calls[0][0].amountCents).toBe(4900);
  });

  test('a bundle over an image is not a disagreement - both are the still price', async () => {
    mockMissionRow = ca({ media_type: 'bundle' });
    storedHead = WEBP_HEAD;
    const res = await request(app).post('/api/payments/create-checkout-session').send({ missionId: 'm1' });

    expect(res.status).toBe(200);
    expect(mockCreateCheckoutSession.mock.calls[0][0].amountCents).toBe(1900);
    // and the stored label is preserved, not flattened to 'image'
    expect(mockUpdateMission.mock.calls[0][2].media_type).toBe('bundle');
  });

  test('an unreadable object does not block a legitimate purchase', async () => {
    mockMissionRow = ca({ media_type: 'image' });
    signFails = true;
    const res = await request(app).post('/api/payments/create-checkout-session').send({ missionId: 'm1' });

    expect(res.status).toBe(200);
    expect(mockCreateCheckoutSession.mock.calls[0][0].amountCents).toBe(1900);
  });

  test('a non-creative mission is untouched by any of this', async () => {
    mockMissionRow = ca({ goal_type: 'validate', respondent_count: 100, media_type: null, brief_attachment: null });
    const res = await request(app).post('/api/payments/create-checkout-session').send({ missionId: 'm1' });
    expect(res.status).toBe(200);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ── free-launch ─────────────────────────────────────────────────────────────
describe('free-launch prices from the stored object too', () => {
  const FREE_PROMO = { code: 'FREELAUNCH', active: true, type: 'free', expires_at: null, max_uses: null, uses_count: 0 };

  test('row says image, object is an mp4 -> refused, never marked paid', async () => {
    mockPromo = FREE_PROMO;
    mockMissionRow = ca({ media_type: 'image' });
    storedHead = MP4_HEAD;
    const res = await request(app).post('/api/payments/free-launch').send({ missionId: 'm1', promoCode: 'FREELAUNCH' });
    await tick();

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('media_type_mismatch');
    expect(mockUpdateMission).not.toHaveBeenCalled();
  });
});

// ── POST /missions/launch - the third money path ────────────────────────────
describe('POST /missions/launch prices from the stored object', () => {
  test('row says image, object is an mp4 -> refused before any PaymentIntent', async () => {
    mockMissionRow = ca({ media_type: 'image' });
    storedHead = MP4_HEAD;
    const res = await request(app).post('/api/missions/launch').send({ missionId: 'm1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('media_type_mismatch');
  });
});

// ── the run gate ────────────────────────────────────────────────────────────
describe('the run gate re-derives, because the file can change after payment', () => {
  test('$19 captured for a mission whose object is an mp4 is refused as a shortfall', async () => {
    storedHead = MP4_HEAD;
    mockRetrievePaymentIntent.mockResolvedValueOnce({ id: 'pi_test', amount_received: 1900 });
    const cover = await checkPaymentCoversRun(supabase, ca({
      status: 'paid', media_type: 'image', latest_payment_intent_id: 'pi_test',
    }));

    expect(cover.ok).toBe(false);
    expect(cover.owedCents).toBe(4900);
    expect(cover.capturedCents).toBe(1900);
    expect(cover.detail.media_type_priced).toBe('video');
    expect(cover.detail.media_type_mismatch).toBe(true);
  });

  test('POSITIVE CONTROL: a genuine $19 image mission still passes the gate', async () => {
    storedHead = JPEG_HEAD;
    mockRetrievePaymentIntent.mockResolvedValueOnce({ id: 'pi_test', amount_received: 1900 });
    const cover = await checkPaymentCoversRun(supabase, ca({
      status: 'paid', media_type: 'image', latest_payment_intent_id: 'pi_test',
    }));

    expect(cover.ok).toBe(true);
    expect(cover.owedCents).toBe(1900);
    expect(cover.detail.media_type_source).toBe('magic_bytes');
  });

  test('POSITIVE CONTROL: a genuine $49 video mission still passes the gate', async () => {
    storedHead = MP4_HEAD;
    mockRetrievePaymentIntent.mockResolvedValueOnce({ id: 'pi_test', amount_received: 4900 });
    const cover = await checkPaymentCoversRun(supabase, ca({
      status: 'paid', media_type: 'video', latest_payment_intent_id: 'pi_test',
    }));

    expect(cover.ok).toBe(true);
    expect(cover.owedCents).toBe(4900);
  });

  test('an unreadable object falls back to the row, it does not refuse the run', async () => {
    signFails = true;
    mockRetrievePaymentIntent.mockResolvedValueOnce({ id: 'pi_test', amount_received: 1900 });
    const cover = await checkPaymentCoversRun(supabase, ca({
      status: 'paid', media_type: 'image', latest_payment_intent_id: 'pi_test',
    }));

    expect(cover.ok).toBe(true);
    expect(cover.detail.media_type_source).toBe('unverifiable');
  });
});
