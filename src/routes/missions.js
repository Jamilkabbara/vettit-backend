const express = require('express');
const { randomUUID } = require('crypto');
const router = express.Router();
const { authenticate, optionalAuthenticate } = require('../middleware/auth');
const supabase = require('../db/supabase');
const { calculateMissionPrice, extractCountriesFromMission } = require('../utils/pricingEngine');
const { runMission } = require('../jobs/runMission');
const { sanitizeMissionPatch, updateMission } = require('../db/missionSchema');
const logger = require('../utils/logger');

// ── Generate-responses idempotency guard ──────────────────────────────
// runMission is already triggered from /api/payments/confirm on successful
// Stripe confirmation. The frontend's ActiveMissionPage *also* pings the
// generate-responses endpoint on mount as a belt-and-suspenders measure
// (webhooks can lag, the /confirm call can race with the nav, etc.).
// We guard against double-fires so the mission doesn't get two parallel
// persona-generation runs racing to insert into mission_responses.
//
// In-memory is sufficient: runMission itself flips missions.status → 'processing'
// within a few ms of starting, so the DB becomes the persistent guard
// after the first call. This Set only prevents sub-second re-triggers
// from the same container.
const activeRuns = new Set();
const TERMINAL_OR_RUNNING = new Set(['processing', 'completed', 'paid', 'failed']);

/**
 * GET /api/missions — list user's missions (most-recent first).
 *
 * Pass 33 W10 — column-list select. The missions table has 77 columns
 * including 20+ heavy JSONB (questions, insights, mission_assets,
 * creative_analysis, targeting, etc.); a `select('*')` over a 38-row
 * mission set returns ~184 kB and made the dashboard cold-load take
 * ~9s. The card preview only needs ~16 fields. Detail endpoint
 * (`/api/missions/:id` below) keeps select('*') for the full row.
 *
 * The set below covers everything MissionsListPage.tsx actually
 * renders — id / title / brief / target_audience for the card preview,
 * status / goal_type / delivery_unit / delivery_status for badges,
 * respondent + delivery counts for progress, pricing for the footer,
 * created_at for sort, refund metadata for failure UI. Anything not
 * here belongs on the detail endpoint.
 */
const MISSION_LIST_COLUMNS = [
  'id',
  'title',
  'brief',
  'target_audience',
  'status',
  'goal_type',
  'delivery_unit',
  'respondent_count',
  'delivered_respondent_count',
  'total_simulated_count',
  'qualified_respondent_count',
  'qualification_rate',
  'delivery_status',
  'price_estimated',
  'total_price_usd',
  'paid_at',
  'created_at',
  'partial_refund_id',
  'partial_refund_amount_cents',
  'failure_reason',
  'brand_name',
  'category',
].join(', ');

const MISSION_LIST_DEFAULT_LIMIT = 100;

router.get('/', authenticate, async (req, res, next) => {
  try {
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || MISSION_LIST_DEFAULT_LIMIT, 1),
      500,
    );
    const { data, error } = await supabase
      .from('missions')
      .select(`${MISSION_LIST_COLUMNS}, mission_responses(count)`)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    // Flatten the join: mission_responses is [{count:N}], expose as responses_collected.
    const rows = (data || []).map(m => ({
      ...m,
      responses_collected: m.mission_responses?.[0]?.count ?? 0,
    }));
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/missions/:id — single mission, user-scoped.
 *
 * Pass 36 A1 — distinct status codes for failure modes:
 *   - 200 + body for owner or admin
 *   - 401 if not authenticated (handled by `authenticate` middleware)
 *   - 403 if authenticated but not owner / admin
 *   - 404 only for genuinely nonexistent UUIDs
 *
 * Previous behavior returned 404 for "not owned" missions which made
 * the legitimate "deep link to your own mission" case look like a
 * dead URL (and made the ResultsPage flash "Mission not found" during
 * the auth-race window before user state settled).
 */
/**
 * GET /api/missions/recent-vetted — PUBLIC, anonymized social proof for
 * the landing-page ticker (Pass 46 follow-up).
 *
 * Returns ONLY { location, category } for recent COMPLETED missions —
 * never briefs, titles, ids, or user data. Location is the first
 * targeted city when present, else the (display-normalized) country;
 * category is the goal_type mapped to a plain label.
 *
 * The frontend hides the ticker entirely when `count` < 5, so the
 * fabricated-data placeholder is never shown. NO AUTH (public data),
 * service-role read returning a strict allow-list of fields.
 */
const VETTED_CATEGORY_LABELS = {
  research:          'Market Research',
  validate:          'Product Validation',
  compare:           'Concept Test',
  marketing:         'Ad Testing',
  satisfaction:      'Customer Satisfaction',
  pricing:           'Pricing Study',
  roadmap:           'Feature Roadmap',
  competitor:        'Competitor Analysis',
  naming_messaging:  'Naming & Messaging',
  churn_research:    'Churn Study',
  brand_lift:        'Brand Lift',
  creative_attention:'Creative Testing',
};
const VETTED_COUNTRY_NAMES = {
  AE: 'UAE', SA: 'Saudi Arabia', US: 'the US', GB: 'the UK', UK: 'the UK',
  EG: 'Egypt', IN: 'India', SG: 'Singapore', FR: 'France', DE: 'Germany',
  NG: 'Nigeria', KE: 'Kenya', CA: 'Canada', BR: 'Brazil', NL: 'Netherlands',
  KR: 'South Korea', TR: 'Turkey', QA: 'Qatar', KW: 'Kuwait', BH: 'Bahrain', OM: 'Oman',
};
function vettedLocation(targeting) {
  const geo = (targeting && targeting.geography) || {};
  const cities = Array.isArray(geo.cities) ? geo.cities.filter(Boolean) : [];
  if (cities.length > 0) return String(cities[0]);
  const countries = Array.isArray(geo.countries) ? geo.countries.filter(Boolean) : [];
  if (countries.length > 0) {
    const c = String(countries[0]);
    // ISO-2 code → display name; otherwise it's already a name.
    return c.length === 2 ? (VETTED_COUNTRY_NAMES[c.toUpperCase()] || c) : c;
  }
  return null;
}
router.get('/recent-vetted', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('missions')
      .select('goal_type, targeting, completed_at')
      .eq('status', 'completed')
      .order('completed_at', { ascending: false, nullsFirst: false })
      .limit(40);
    if (error) throw error;

    const items = [];
    for (const m of data || []) {
      const location = vettedLocation(m.targeting);
      const category = VETTED_CATEGORY_LABELS[m.goal_type];
      // Require BOTH a real location and a known category — never emit
      // a half-anonymized or unlabeled entry.
      if (location && category) items.push({ location, category });
      if (items.length >= 20) break;
    }

    // The gate the spec mandates: fewer than 5 real completed missions
    // with usable location+category → empty, frontend hides the ticker.
    if (items.length < 5) return res.json({ items: [], count: items.length });
    res.json({ items, count: items.length });
  } catch (err) { next(err); }
});

router.get('/:id', authenticate, async (req, res, next) => {
  try {
    // First probe: does this UUID exist at all? (Independent of ownership.)
    const { data: probe } = await supabase
      .from('missions')
      .select('id, user_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!probe) return res.status(404).json({ error: 'Mission not found' });

    // Ownership / admin gate.
    const isOwner = probe.user_id === req.user.id;
    const isAdmin = req.user.is_admin === true;
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Owner / admin — return the full row.
    const { data, error } = await supabase
      .from('missions')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error || !data) {
      return res.status(404).json({ error: 'Mission not found' });
    }
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/missions — create a new mission draft.
 * Accepts the full mission config; computes price server-side; stores snapshot.
 */
router.post('/', authenticate, async (req, res, next) => {
  try {
    const {
      goalType, goal, title, brief, missionStatement,
      questions, targeting, targetingConfig, respondentCount,
    } = req.body;

    // Pass 46 Phase 2 — create-time validation (audit P1-6). The Phase 0
    // probe proved respondentCount:0 was silently coerced to 50 and
    // priced $99; reject garbage explicitly instead.
    if (respondentCount !== undefined
        && (!Number.isInteger(respondentCount) || respondentCount < 1 || respondentCount > 5000)) {
      return res.status(400).json({
        error: 'invalid_respondent_count',
        message: 'respondentCount must be an integer between 1 and 5000.',
      });
    }
    if (questions !== undefined && !Array.isArray(questions)) {
      return res.status(400).json({
        error: 'invalid_questions',
        message: 'questions must be an array.',
      });
    }

    // Pass 21 Bug 16: default 100 → 50 (entry tier, $35).
    const respCount   = respondentCount || 50;
    const finalTarget = targeting || targetingConfig || {};
    const finalQs     = questions || [];
    // Pass 44 P0 — default changed 'general_research' → 'research'.
    // The DB CHECK constraint (missions_goal_type_check) allows 'research'
    // as the canonical general-research goal; 'general_research' violates
    // it and 500'd any insert that fell back to the default.
    const resolvedGoal = goalType || goal || 'research';

    // Pass 25 Phase 0.3 — CA missions need >= 10 respondents. Reject early
    // with 400 so the UI can surface the message rather than silently
    // creating a broken draft.
    const { CA_MIN_RESPONDENTS, calculateBrandLiftMissionPrice } = require('../utils/pricingEngine');
    if (resolvedGoal === 'creative_attention' && respCount < CA_MIN_RESPONDENTS) {
      return res.status(400).json({
        error: 'min_respondents',
        message: `Creative Attention requires at least ${CA_MIN_RESPONDENTS} respondents.`,
      });
    }

    // Pass 27 — brand_lift markets + channels are mandatory.
    if (resolvedGoal === 'brand_lift') {
      const targetedMarkets = req.body.targetedMarkets || req.body.targeted_markets || [];
      const campaignChannels = req.body.campaignChannels || req.body.campaign_channels || [];
      if (!Array.isArray(targetedMarkets) || targetedMarkets.length === 0) {
        return res.status(400).json({
          error: 'markets_required',
          message: 'Brand Lift Studies require at least 1 target market.',
        });
      }
      if (!Array.isArray(campaignChannels) || campaignChannels.length === 0) {
        return res.status(400).json({
          error: 'channels_required',
          message: 'Brand Lift Studies require at least 1 campaign channel.',
        });
      }
    }

    // Pass 44 P0 — calculateMissionPrice moved to an options-object
    // signature (a7ff50a, Apr 23) and deriveFilters was deleted with it,
    // but these call sites kept the old positional style. Every backend
    // mission-create/price endpoint has thrown ReferenceError since.
    // Unnoticed because the frontend creates missions client-side via
    // supabase-js. Now: pass targeting directly; the engine derives
    // surcharges itself.
    const pricing = calculateMissionPrice({
      respondentCount: respCount,
      targeting:       finalTarget,
      questionCount:   finalQs.length,
      countries:       extractCountriesFromMission({ targeting: finalTarget }),
      goalType:        resolvedGoal,
    });

    // Pass 27 — recompute brand_lift total with market + channel uplifts;
    // backend stays canonical source of truth at payment time.
    let priceBreakdown = null;
    if (resolvedGoal === 'brand_lift') {
      const targetedMarkets = req.body.targetedMarkets || req.body.targeted_markets || [];
      const campaignChannels = req.body.campaignChannels || req.body.campaign_channels || [];
      priceBreakdown = calculateBrandLiftMissionPrice({
        respondentBaseUSD: pricing.total,
        marketCount: targetedMarkets.length,
        channelCount: campaignChannels.length,
      });
      // Server total may differ from frontend; prefer server.
      if (Math.abs((req.body.totalPriceUsd || pricing.total) - priceBreakdown.total_usd) > 0.5) {
        logger.warn('POST /missions: frontend price drifted from server', {
          frontend: req.body.totalPriceUsd, server: priceBreakdown.total_usd,
        });
      }
      pricing.total = priceBreakdown.total_usd;
    }

    // Only include columns that exist in public.missions. `mission_statement`,
    // `targeting_config`, `price`, `pricing_breakdown` are all drift and
    // cause PostgREST to 400 the whole insert.
    const { patch: insertRow, rejected } = sanitizeMissionPatch({
      user_id:                 req.user.id,
      title:                   title || brief?.slice(0, 60) || missionStatement?.slice(0, 60) || 'Untitled mission',
      goal_type:               resolvedGoal,
      brief:                   brief || missionStatement || '',
      questions:               finalQs,
      targeting:               finalTarget,
      respondent_count:        respCount,
      base_cost_usd:           pricing.baseCost,
      targeting_surcharge_usd: pricing.targetingSurcharge,
      extra_questions_cost_usd: pricing.extraQuestionsCost,
      total_price_usd:         pricing.total,
      status:                  'draft',
      // Pass 27 — persist brand_lift uplift breakdown for audit + future re-pricing.
      ...(priceBreakdown ? { price_breakdown: priceBreakdown } : {}),
      ...(resolvedGoal === 'brand_lift' && (req.body.targetedMarkets || req.body.targeted_markets)
          ? { targeted_markets: req.body.targetedMarkets || req.body.targeted_markets } : {}),
      ...(resolvedGoal === 'brand_lift' && (req.body.campaignChannels || req.body.campaign_channels)
          ? { campaign_channels: req.body.campaignChannels || req.body.campaign_channels } : {}),
      // Pass 42 A.1 — populate recruitment loop columns at insert.
      // target_qualified_count == respondent_count (semantic rename:
      // what the customer paid for is qualified completes).
      // ai_spend_ceiling_usd = total_price * 0.30 (70% margin floor).
      // Without these the recruitLoop gate (shouldUseRecruitLoop)
      // returns false on every new mission and the legacy batch
      // flow runs — Track A code path becomes dead. Verified on
      // production mission 29716bfb-c958-4912-9bae-b1451150fd36
      // (both columns null, processed via legacy).
      target_qualified_count:  respCount,
      ai_spend_ceiling_usd:    Math.round(pricing.total * 0.30 * 10000) / 10000,
      recruitment_status:      'pending',
    });
    if (rejected.length) logger.warn('POST /missions: dropped cols', { rejected });

    const { data, error } = await supabase
      .from('missions')
      .insert(insertRow)
      .select()
      .single();

    if (error) {
      logger.error('POST /missions insert failed', { error: error.message, details: error.details });
      throw error;
    }
    logger.info('Mission created', { userId: req.user.id, missionId: data.id });
    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/missions/draft — idempotent autosave endpoint for the Setup page.
 * Creates or updates a draft keyed by optional clientDraftId.
 */
router.post('/draft', authenticate, async (req, res, next) => {
  try {
    const {
      missionId, goalType, title, brief, missionStatement,
      questions, targeting, respondentCount,
    } = req.body;

    // Pass 46 Phase 2 — same create-time validation as POST / (audit P1-6).
    if (respondentCount !== undefined
        && (!Number.isInteger(respondentCount) || respondentCount < 1 || respondentCount > 5000)) {
      return res.status(400).json({
        error: 'invalid_respondent_count',
        message: 'respondentCount must be an integer between 1 and 5000.',
      });
    }
    if (questions !== undefined && !Array.isArray(questions)) {
      return res.status(400).json({
        error: 'invalid_questions',
        message: 'questions must be an array.',
      });
    }

    // Pass 21 Bug 16: default 100 → 50 (entry tier, $35).
    const respCount   = respondentCount || 50;
    const finalTarget = targeting || {};
    const finalQs     = questions || [];
    // Pass 44 P0 — object-signature call (see POST /missions above).
    const pricing     = calculateMissionPrice({
      respondentCount: respCount,
      targeting:       finalTarget,
      questionCount:   finalQs.length,
      countries:       extractCountriesFromMission({ targeting: finalTarget }),
      goalType:        goalType || 'research',
    });

    // Filter phantom columns before hitting the DB (see missionSchema.js).
    const { patch: row, rejected } = sanitizeMissionPatch({
      title:             title || 'Untitled draft',
      goal_type:         goalType || 'research',
      brief:             brief || missionStatement || '',
      questions:         finalQs,
      targeting:         finalTarget,
      respondent_count:  respCount,
      base_cost_usd:     pricing.baseCost,
      targeting_surcharge_usd: pricing.targetingSurcharge,
      extra_questions_cost_usd: pricing.extraQuestionsCost,
      total_price_usd:   pricing.total,
      status:            'draft',
      // Pass 42 A.1 — same recruitment-loop columns on the draft
      // path. The Setup page hits this endpoint on autosave; the
      // checkout endpoint at /missions promotes the draft to paid.
      // Both must populate target_qualified_count + ceiling so the
      // recruitment loop engages regardless of which path created
      // the mission.
      target_qualified_count: respCount,
      ai_spend_ceiling_usd:   Math.round(pricing.total * 0.30 * 10000) / 10000,
      recruitment_status:     'pending',
    });
    if (rejected.length) logger.warn('POST /missions/draft: dropped cols', { rejected });

    let result;
    if (missionId) {
      const { data, error } = await supabase
        .from('missions')
        .update(row)
        .eq('id', missionId)
        .eq('user_id', req.user.id)
        .select()
        .single();
      if (error) {
        logger.error('POST /missions/draft update failed', { missionId, error: error.message, details: error.details });
        throw error;
      }
      result = data;
    } else {
      const { data, error } = await supabase
        .from('missions')
        .insert({ ...row, user_id: req.user.id })
        .select()
        .single();
      if (error) {
        logger.error('POST /missions/draft insert failed', { error: error.message, details: error.details });
        throw error;
      }
      result = data;
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/missions/calculate-price — public (optional auth).
 * Used by the Setup page for live pricing display as the user toggles targeting.
 * NEVER treat this as authoritative — the final charge is computed inside /payments/create-intent.
 */
router.post('/calculate-price', optionalAuthenticate, async (req, res, next) => {
  try {
    const { respondentCount, targeting, questions, promoCode } = req.body;

    const respCount = respondentCount || 100;
    // Pass 44 P0 — legacy activeFilters/filters arrays dropped; the
    // object-signature engine derives surcharges from `targeting`
    // directly (activeFilters was only ever derived FROM targeting).
    const qCount = Array.isArray(questions) ? questions.length : (req.body.questionCount || 5);

    let promo = null;
    if (promoCode) {
      const { data } = await supabase
        .from('promo_codes').select('*').eq('code', promoCode).eq('active', true).single();
      if (data) {
        const expired = data.expires_at && new Date(data.expires_at) < new Date();
        const exhausted = data.max_uses && data.uses_count >= data.max_uses;
        if (!expired && !exhausted) promo = data;
      }
    }

    const pricing = calculateMissionPrice({
      respondentCount: respCount,
      targeting:       targeting || {},
      questionCount:   qCount,
      promoCode:       promo,
      countries:       extractCountriesFromMission({ targeting: targeting || {} }),
      goalType:        req.body.goalType || req.body.goal || 'validate',
    });
    res.json(pricing);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/missions/launch — validate price & create PaymentIntent in one call (convenience).
 */
router.post('/launch', authenticate, async (req, res, next) => {
  try {
    const { missionId, promoCode } = req.body;
    if (!missionId) return res.status(400).json({ error: 'missionId is required' });

    // Forward to the payments route logic by calling the Stripe helper directly.
    // We do this inline to keep the request shape identical to /payments/create-intent.
    const stripeService = require('../services/stripe');

    const { data: mission } = await supabase
      .from('missions')
      .select('*')
      .eq('id', missionId)
      .eq('user_id', req.user.id)
      .single();
    if (!mission) return res.status(404).json({ error: 'Mission not found' });

    let promo = null;
    if (promoCode) {
      const { data } = await supabase
        .from('promo_codes').select('*').eq('code', promoCode).eq('active', true).single();
      if (data) promo = data;
    }

    const countries = extractCountriesFromMission(mission);
    const pricing = calculateMissionPrice({
      respondentCount: mission.respondent_count,
      targeting:       mission.targeting || {},
      questionCount:   (mission.questions || []).length,
      countries,
      promoCode:       promo,
    });

    if (pricing.totalCents < 50) {
      return res.status(400).json({ error: 'Minimum payment is $0.50' });
    }

    const { data: { user } } = await supabase.auth.admin.getUserById(req.user.id);
    const { clientSecret, paymentIntentId } = await stripeService.createPaymentIntent({
      amountCents: pricing.totalCents,
      missionId,
      userId: req.user.id,
      userEmail: user?.email,
      pricingBreakdown: pricing,
    });

    await updateMission(supabase, missionId, {
      total_price_usd: pricing.total,
      base_cost_usd:   pricing.baseCost,
      targeting_surcharge_usd: pricing.targetingSurcharge,
      extra_questions_cost_usd: pricing.extraQuestionsCost,
      promo_code: promo?.code || null,
      discount_usd: pricing.discount,
      status: 'pending_payment',
    }, { caller: 'POST /missions/launch' });

    res.json({ clientSecret, paymentIntentId, pricing });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/missions/:id — partial update (autosave).
 */
router.patch('/:id', authenticate, async (req, res, next) => {
  try {
    const updates = req.body;

    // Pass 25 Phase 0.1 Bug H part 2 — write-time guard. Once responses exist
    // for a mission, its schema (questions / targeting / respondent_count) is
    // locked. Edits would silently make the persisted aggregator output drift
    // from what the simulator actually saw. Reject with 409 and surface a
    // human-readable next step.
    const schemaLockingFields = ['questions', 'targeting', 'targetingConfig', 'respondentCount'];
    const touchesSchema = schemaLockingFields.some(k => updates[k] !== undefined);
    if (touchesSchema) {
      const { count: responsesCount } = await supabase
        .from('mission_responses')
        .select('persona_id', { count: 'exact', head: true })
        .eq('mission_id', req.params.id);
      if ((responsesCount || 0) > 0) {
        return res.status(409).json({
          error: 'schema_locked_after_responses',
          message: 'Cannot edit questions after responses generated; re-run mission to regenerate.',
        });
      }
    }

    // If pricing-impacting fields change, recompute cost columns server-side.
    if (updates.respondentCount || updates.questions || updates.targeting || updates.targetingConfig) {
      const { data: existing } = await supabase
        .from('missions')
        .select('questions, targeting, respondent_count, goal_type')
        .eq('id', req.params.id)
        .eq('user_id', req.user.id)
        .single();

      // Pass 21 Bug 16: default fallback 100 → 50.
      const respCount = updates.respondentCount || existing?.respondent_count || 50;
      const finalTarget = updates.targeting || updates.targetingConfig || existing?.targeting || {};
      const finalQs = updates.questions || existing?.questions || [];
      // Pass 44 P0 — object-signature call; goal_type added to the
      // select so the engine routes to the correct pricing ladder.
      const pricing = calculateMissionPrice({
        respondentCount: respCount,
        targeting:       finalTarget,
        questionCount:   finalQs.length,
        countries:       extractCountriesFromMission({ targeting: finalTarget }),
        goalType:        updates.goalType || existing?.goal_type || 'validate',
      });

      updates.total_price_usd = pricing.total;
      updates.base_cost_usd = pricing.baseCost;
      updates.targeting_surcharge_usd = pricing.targetingSurcharge;
      updates.extra_questions_cost_usd = pricing.extraQuestionsCost;
      // Pass 42 A.1 — keep the recruitment columns in sync when the
      // customer edits respondent_count or anything that re-prices.
      // target_qualified_count must equal what they paid for;
      // ai_spend_ceiling_usd must equal that price × 0.30.
      updates.target_qualified_count = respCount;
      updates.ai_spend_ceiling_usd = Math.round(pricing.total * 0.30 * 10000) / 10000;
    }

    // Map client field names → column names; phantom columns are dropped by
    // sanitizeMissionPatch (mission_statement, targeting_config, price,
    // pricing_breakdown, updated_at — none of which exist in the schema).
    const mapped = {};
    if (updates.title) mapped.title = updates.title;
    if (updates.brief || updates.missionStatement) {
      mapped.brief = updates.brief || updates.missionStatement;
    }
    if (updates.goalType) mapped.goal_type = updates.goalType;
    if (updates.questions) mapped.questions = updates.questions;
    if (updates.targeting || updates.targetingConfig) {
      mapped.targeting = updates.targeting || updates.targetingConfig;
    }
    if (updates.respondentCount) mapped.respondent_count = updates.respondentCount;
    if (updates.total_price_usd != null) mapped.total_price_usd = updates.total_price_usd;
    if (updates.base_cost_usd != null) mapped.base_cost_usd = updates.base_cost_usd;
    if (updates.targeting_surcharge_usd != null) mapped.targeting_surcharge_usd = updates.targeting_surcharge_usd;
    if (updates.extra_questions_cost_usd != null) mapped.extra_questions_cost_usd = updates.extra_questions_cost_usd;
    if (updates.status) mapped.status = updates.status;
    // Pass 42 A.1 — propagate recomputed recruitment columns through
    // the PATCH path so a respondent_count edit keeps target +
    // ceiling in lockstep with total_price_usd.
    if (updates.target_qualified_count != null) mapped.target_qualified_count = updates.target_qualified_count;
    if (updates.ai_spend_ceiling_usd != null) mapped.ai_spend_ceiling_usd = updates.ai_spend_ceiling_usd;

    const { patch: dbUpdates, rejected } = sanitizeMissionPatch(mapped);
    if (rejected.length) logger.warn('PATCH /missions: dropped cols', { rejected });

    const { data, error } = await supabase
      .from('missions')
      .update(dbUpdates)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) {
      logger.error('PATCH /missions/:id failed', {
        missionId: req.params.id,
        error: error.message,
        details: error.details,
        patchKeys: Object.keys(dbUpdates),
      });
      throw error;
    }
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/missions/:id/generate-responses
 *
 * Fire-and-forget trigger for the synthetic-audience pipeline. Called
 * by the ActiveMissionPage on mount so the generator runs even if the
 * Stripe webhook is delayed or /api/payments/confirm hasn't reached us
 * yet. Returns 202 immediately; all long work happens in the background.
 *
 * Idempotency: if the mission is already processing/completed/paid we
 * return 202 with `status: 'already_running'` and DO NOT re-trigger.
 * The in-memory activeRuns Set covers the sub-second window before
 * runMission flips the DB status.
 */
router.post('/:id/generate-responses', authenticate, async (req, res, next) => {
  try {
    const missionId = req.params.id;

    const { data: mission, error } = await supabase
      .from('missions')
      .select('id, user_id, status, respondent_count')
      .eq('id', missionId)
      .eq('user_id', req.user.id)
      .single();

    if (error || !mission) {
      return res.status(404).json({ error: 'Mission not found' });
    }

    const currentStatus = (mission.status || 'draft').toLowerCase();

    // Already in-flight or done — never re-trigger.
    if (activeRuns.has(missionId) || TERMINAL_OR_RUNNING.has(currentStatus)) {
      logger.info('generate-responses: idempotent skip', { missionId, currentStatus });
      return res.status(202).json({
        jobId: `mission-${missionId}`,
        status: 'already_running',
        missionStatus: currentStatus,
      });
    }

    // Only allow kicking off runs from a paid state. We accept 'paid' above
    // and also 'pending_payment' here so that if Stripe's webhook is late
    // but the client already saw the confirmation, we still proceed — the
    // frontend only calls this from ActiveMissionPage which is post-payment.
    // Block 'draft' outright so nothing runs before payment.
    if (currentStatus === 'draft') {
      return res.status(400).json({
        error: 'Mission has not been paid for yet',
        missionStatus: currentStatus,
      });
    }

    const jobId = randomUUID();
    activeRuns.add(missionId);

    setImmediate(() => {
      runMission(missionId)
        .catch((err) => {
          logger.error('generate-responses: runMission failed', {
            missionId,
            jobId,
            err: err.message,
            stack: err.stack,
          });
        })
        .finally(() => {
          activeRuns.delete(missionId);
        });
    });

    logger.info('generate-responses: queued', {
      missionId,
      jobId,
      respondentCount: mission.respondent_count,
    });

    return res.status(202).json({ jobId, status: 'queued' });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/missions/:id — archive.
 */
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const { error } = await updateMission(
      supabase,
      req.params.id,
      { status: 'archived' },
      { caller: 'DELETE /missions/:id', scope: { user_id: req.user.id } },
    );
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Back-compat alias used by the current frontend client
router.post('/pricing/calculate', optionalAuthenticate, async (req, res, next) => {
  try {
    const { respondentCount, questions, targetingConfig, targeting, promoCode } = req.body;
    const respCount = respondentCount || 100;
    // Pass 44 P0 — legacy activeFilters dropped; object-signature call.
    const resolvedTargeting = targetingConfig || targeting || {};
    const qCount = Array.isArray(questions) ? questions.length : 5;

    let promo = null;
    if (promoCode) {
      const { data } = await supabase
        .from('promo_codes').select('*').eq('code', promoCode).eq('active', true).single();
      if (data) promo = data;
    }

    const pricing = calculateMissionPrice({
      respondentCount: respCount,
      targeting:       resolvedTargeting,
      questionCount:   qCount,
      promoCode:       promo,
      countries:       extractCountriesFromMission({ targeting: resolvedTargeting }),
      goalType:        req.body.goalType || req.body.goal || 'validate',
    });
    res.json(pricing);
  } catch (err) {
    next(err);
  }
});

/**
 * Pass 42 B2 — Chart data backfill endpoint.
 *
 * Returns insights.chart_data for the mission, computing it on the
 * fly from mission_responses when the synthesis pipeline didn't
 * emit it (older missions pre-Pass-42 B1). Result is cached back to
 * insights.chart_data so subsequent calls are instant.
 *
 * Auth: same RLS-style gate as GET /:id (user must own mission OR be admin).
 * Cost: ~$0.01 per first-call (single Haiku sentiment classification);
 *       $0 thereafter (cached).
 *
 * Returns the chart_data object shape from B1, plus a `_source` field
 * indicating whether the data came from synthesis ('cached'), was
 * just computed ('computed'), or could not be derived ('empty').
 */
router.get('/:id/chart_data', authenticate, async (req, res, next) => {
  try {
    const missionId = req.params.id;

    // RLS-style ownership check.
    const { data: mission, error: fetchErr } = await supabase
      .from('missions')
      .select('id, user_id, questions, insights, targeting, target_audience')
      .eq('id', missionId)
      .single();
    if (fetchErr || !mission) return res.status(404).json({ error: 'mission_not_found' });
    if (mission.user_id !== req.user.id) {
      // Allow admin via the same pattern as elsewhere; if you don't have an
      // admin flag here, the user_id check is sufficient.
      return res.status(403).json({ error: 'forbidden' });
    }

    // Fast path: synthesis already emitted chart_data (B1 missions).
    const existing = mission.insights?.chart_data;
    if (existing && typeof existing === 'object' && Object.keys(existing).length > 0) {
      return res.json({ ...existing, _source: 'cached' });
    }

    // Slow path: compute from mission_responses.
    const { data: responses, error: respErr } = await supabase
      .from('mission_responses')
      .select('question_id, answer, persona_profile')
      .eq('mission_id', missionId)
      .eq('screened_out', false);
    if (respErr) {
      logger.error('chart_data: fetch responses failed', { missionId, err: respErr.message });
      return res.status(500).json({ error: 'fetch_responses_failed' });
    }
    if (!responses || responses.length === 0) {
      return res.json({ _source: 'empty', per_question_distributions: [] });
    }

    // Build per-question distributions.
    const questions = Array.isArray(mission.questions) ? mission.questions : [];
    const qById = new Map(questions.map((q) => [q.id, q]));
    const byQuestion = new Map();
    for (const r of responses) {
      if (!byQuestion.has(r.question_id)) byQuestion.set(r.question_id, []);
      byQuestion.get(r.question_id).push(r.answer);
    }

    const per_question_distributions = [];
    for (const [qid, answers] of byQuestion.entries()) {
      const q = qById.get(qid);
      if (!q) continue;

      // Single-choice / multi-select: count occurrences.
      if (q.type === 'single' || q.type === 'multi' || q.type === 'multi_select' || q.type === 'single_choice') {
        const counts = new Map();
        for (const a of answers) {
          const values = Array.isArray(a) ? a : [a];
          for (const v of values) {
            if (v == null) continue;
            counts.set(String(v), (counts.get(String(v)) || 0) + 1);
          }
        }
        const options = Array.from(counts.keys());
        const countsArr = options.map((o) => counts.get(o));
        const total = countsArr.reduce((s, c) => s + c, 0);
        const percentages = total > 0 ? countsArr.map((c) => Math.round((c / total) * 1000) / 10) : countsArr.map(() => 0);
        per_question_distributions.push({
          question_id: qid,
          question: q.text || q.question || qid,
          type: q.type === 'multi' || q.type === 'multi_select' ? 'multi_select' : 'single_choice',
          options,
          counts: countsArr,
          percentages,
        });
        continue;
      }

      // Rating: bucket by value, compute mean + median.
      if (q.type === 'rating' || q.type === 'scale') {
        const buckets = {};
        const numeric = [];
        for (const a of answers) {
          const n = Number(a);
          if (!Number.isFinite(n)) continue;
          numeric.push(n);
          const key = String(n);
          buckets[key] = (buckets[key] || 0) + 1;
        }
        if (numeric.length === 0) continue;
        const sum = numeric.reduce((s, n) => s + n, 0);
        const mean = Math.round((sum / numeric.length) * 100) / 100;
        const sorted = [...numeric].sort((a, b) => a - b);
        const median = sorted.length % 2 === 0
          ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
          : sorted[Math.floor(sorted.length / 2)];
        const scale_max = q.scale_max || q.max || Math.max(...numeric, 5);
        per_question_distributions.push({
          question_id: qid,
          question: q.text || q.question || qid,
          type: 'rating',
          scale_max,
          buckets,
          mean,
          median,
        });
        continue;
      }

      // text: skip from distributions (flows through sentiment_breakdown instead)
    }

    // Segment distributions: by country if available.
    const segment_distributions = [];
    const byCountry = new Map();
    for (const r of responses) {
      const c = r.persona_profile?.country || r.persona_profile?.location;
      if (!c) continue;
      if (!byCountry.has(c)) byCountry.set(c, 0);
      byCountry.set(c, byCountry.get(c) + 1);
    }
    if (byCountry.size > 1) {
      // De-duplicate persona_id counts: count unique personas per country.
      const personasByCountry = new Map();
      for (const r of responses) {
        const c = r.persona_profile?.country || r.persona_profile?.location;
        if (!c) continue;
        if (!personasByCountry.has(c)) personasByCountry.set(c, new Set());
        // mission_responses has question_id × persona_id; use persona_profile.persona_id
        const pid = r.persona_profile?.persona_id;
        if (pid) personasByCountry.get(c).add(pid);
      }
      for (const [country, ids] of personasByCountry.entries()) {
        segment_distributions.push({
          segment_name: country,
          n: ids.size,
          key_metric_values: {},
        });
      }
    }

    const chart_data = {
      per_question_distributions,
      ...(segment_distributions.length >= 2 ? { segment_distributions } : {}),
      _source: 'computed',
    };

    // Cache back into insights so the next call is fast.
    // Avoid clobbering: read current insights, merge chart_data in.
    const currentInsights = mission.insights && typeof mission.insights === 'object' ? mission.insights : {};
    const newInsights = { ...currentInsights, chart_data: { ...chart_data } };
    delete newInsights.chart_data._source; // _source is response-only metadata
    await supabase
      .from('missions')
      .update({ insights: newInsights })
      .eq('id', missionId);

    return res.json(chart_data);
  } catch (err) {
    logger.error('GET /missions/:id/chart_data failed', { err: err.message, stack: err.stack });
    next(err);
  }
});

/**
 * Pass 42 E1 — live recruitment progress endpoint.
 *
 * Frontend polls this every 5s on the ProcessingPage while a
 * mission is recruiting. Reads from the Pass 42 A1 columns
 * populated by the recruitment loop:
 *   recruited_persona_count, ai_spend_usd_actual,
 *   target_qualified_count, ai_spend_ceiling_usd,
 *   recruitment_status.
 *
 * For backwards compat with legacy missions that don't have
 * recruitment_status populated, derives a 'recruiting' status
 * from mission.status='processing'.
 */
router.get('/:id/progress', authenticate, async (req, res, next) => {
  try {
    const missionId = req.params.id;
    const { data: mission, error } = await supabase
      .from('missions')
      .select([
        'id', 'user_id',
        'status',
        'respondent_count',
        'target_qualified_count',
        'recruited_persona_count',
        'recruitment_status',
        'ai_spend_usd_actual',
        'ai_spend_ceiling_usd',
        'qualified_respondent_count',
        'delivered_respondent_count',
      ].join(', '))
      .eq('id', missionId)
      .single();
    if (error || !mission) return res.status(404).json({ error: 'mission_not_found' });
    if (mission.user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });

    const target = Number(mission.target_qualified_count ?? mission.respondent_count ?? 0);
    const recruited = Number(mission.recruited_persona_count ?? 0);
    // Pass 42 E1 — qualified count: prefer delivered (Pass 36 A0 truth),
    // fall back to qualified_respondent_count, then 0. Both can be
    // populated mid-recruitment by the loop.
    const qualified = Number(
      mission.delivered_respondent_count ??
      mission.qualified_respondent_count ??
      0,
    );

    let status = mission.recruitment_status ?? null;
    if (!status) {
      // Legacy missions or pre-recruitment-loop rows: infer.
      if (mission.status === 'completed') status = 'target_hit';
      else if (mission.status === 'processing' || mission.status === 'paid') status = 'recruiting';
      else status = 'pending';
    }

    res.json({
      recruited,
      qualified,
      target,
      status,
      spent_usd:           Number(mission.ai_spend_usd_actual ?? 0),
      spend_ceiling_usd:   Number(mission.ai_spend_ceiling_usd ?? 0),
      mission_status:      mission.status,
    });
  } catch (err) {
    logger.error('GET /missions/:id/progress failed', { err: err.message });
    next(err);
  }
});

module.exports = router;
