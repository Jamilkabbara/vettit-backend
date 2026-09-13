/**
 * The single function that computes the pricing / targeting snapshot. Both the
 * generator and the test call it, so the thing that was recorded and the thing
 * that is checked cannot be computed two different ways.
 */
const engine = require('../../src/utils/pricingEngine');
const schema = require('../../src/db/missionSchema');

// Every goal type that exists in production, plus the methodology names the
// backend advertises. A type the engine does not know is still recorded - its
// current behaviour (whatever it is) is the behaviour to preserve.
const GOAL_TYPES = [
  'validate', 'research', 'pricing', 'naming_messaging', 'roadmap', 'compare',
  'churn_research', 'competitor', 'audience_profiling', 'marketing',
  'satisfaction', 'market_entry', 'brand_lift', 'creative_attention',
  'ad_effectiveness', 'brand_health_tracker', 'churn_driver', 'concept_test',
  'customer_satisfaction', 'feature_roadmap', 'naming_monadic', 'segmentation',
  'sequential_monadic',
];
const COUNTS = [1, 5, 10, 25, 50, 100, 240, 1000, 1250, 1500];
const QUESTION_COUNTS = [5, 14];
const TARGETING = {
  none: {},
  countries_only: { geography: { countries: ['AE', 'SA'] } },
  full: {
    geography:      { countries: ['AE'], cities: ['Dubai'] },
    demographics:   { ageRanges: ['25-34'], genders: ['female'] },
    professional:   { roles: ['Marketing'], industries: ['Retail'], companySizes: ['50-200'] },
    technographics: { devices: ['iOS'] },
    behaviors:      ['frequent_shoppers'],
    financials:     { incomeRanges: ['high'] },
  },
};
const PROMOS = {
  none: null,
  pct50: { code: 'GOLDEN50', type: 'percentage', value: 50 },
  flat10: { code: 'GOLDEN10', type: 'flat', value: 10 },
  free: { code: 'GOLDENFREE', type: 'free', value: 100 },
};
const MEDIA = [undefined, 'image', 'video', 'bundle', 'series'];

// Keep every number and flag the engine returns (all of price, every
// surcharge, discount, cents, custom-quote) plus the tier id. Drop only the
// echoed inputs and display strings, which carry no price and quadrupled the
// file.
function priceShape(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return r;
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
  }
  if (r.volumeTier && typeof r.volumeTier === 'object') {
    out.volumeTier = { id: r.volumeTier.id, anchorCount: r.volumeTier.anchorCount, packagePrice: r.volumeTier.packagePrice };
  }
  return out;
}

function settle(fn, shape = (x) => x) {
  try { return { ok: shape(fn()) }; }
  catch (e) { return { threw: e && e.constructor ? e.constructor.name : 'Error', message: String(e && e.message) }; }
}

function buildGolden() {
  const cases = {};
  for (const goalType of GOAL_TYPES) {
    const mediaSet = goalType === 'creative_attention' ? MEDIA : [undefined];
    for (const mediaType of mediaSet) {
      for (const respondentCount of COUNTS) {
        for (const questionCount of QUESTION_COUNTS) {
          for (const [tName, targeting] of Object.entries(TARGETING)) {
            for (const [pName, promoCode] of Object.entries(PROMOS)) {
              const key = [goalType, mediaType || '-', respondentCount, questionCount, tName, pName].join('|');
              const countries = (targeting.geography && targeting.geography.countries) || [];
              cases[key] = settle(() => engine.calculateMissionPrice({
                respondentCount, targeting, questionCount, countries, promoCode, goalType, mediaType,
              }), priceShape);
            }
          }
        }
      }
      // tier resolution and floors, independent of targeting
      cases[`resolveTier|${goalType}|${mediaType || '-'}`] = settle(() =>
        COUNTS.map((respondentCount) => engine.resolveTier({ goalType, respondentCount, mediaType })));
      cases[`goalMinRespondents|${goalType}`] = settle(() => engine.goalMinRespondents(goalType));
    }
  }

  // How a stored mission row yields the countries every money route passes
  // in. Includes both Creative Attention audience shapes found in production:
  // a plain string, and the object form two unrun drafts hold.
  const rows = {
    survey_targeting_geo:   { goal_type: 'validate', targeting: { geography: { countries: ['US', 'GB'] } } },
    survey_ta_ai_targeting: { goal_type: 'validate', target_audience: { aiTargeting: { countries: ['AE'] } } },
    survey_ta_suggestions:  { goal_type: 'research', target_audience: { suggestions: { countries: ['SA'] } } },
    brand_lift_markets:     { goal_type: 'brand_lift', targeted_markets: ['SA', 'AE'], targeting: { geography: { countries: ['AE'] } } },
    ca_legacy_string:       { goal_type: 'creative_attention', target_audience: 'Mothers in Saudi' },
    ca_legacy_object_draft: { goal_type: 'creative_attention', target_audience: { price: '20_50', stage: 'pre_launch', market: 'uae_gulf' } },
    ca_new_fields:          { goal_type: 'creative_attention', ca_target_audience: 'Mothers in Saudi', ca_placement: 'tiktok_feed', ca_market: 'SA' },
    empty:                  {},
  };
  const countries = {};
  for (const [name, row] of Object.entries(rows)) {
    countries[name] = settle(() => engine.extractCountriesFromMission(row));
  }

  // Which columns a client may write, and which only the server may. The new
  // Creative Attention columns are excluded so this records only what existed
  // before them: adding a column must not reclassify an existing one.
  const NEW_CA_COLUMNS = new Set(['ca_target_audience', 'ca_placement', 'ca_market']);
  const listOf = (v) => [...(v instanceof Set ? v : new Set(v))].filter((c) => !NEW_CA_COLUMNS.has(c)).sort();
  const schemaLists = {
    ALLOWED_COLUMNS:          listOf(schema.ALLOWED_COLUMNS),
    SERVER_OWNED_COLUMNS:     listOf(schema.SERVER_OWNED_COLUMNS),
    CLIENT_PATCHABLE_COLUMNS: listOf(schema.CLIENT_PATCHABLE_COLUMNS),
  };

  return { generated_from: 'main 2968bd2, before Creative Attention placement and market', cases, countries, schema: schemaLists };
}

module.exports = { buildGolden, GOAL_TYPES, COUNTS, TARGETING, PROMOS };
