/**
 * VETT — mission category taxonomy (benchmark key).
 *
 * WHY A CLOSED ENUM
 * ─────────────────
 * The point of stamping a category on every mission is to make results
 * COMPARABLE: "how did this pricing study score against other F&B pricing
 * studies?". That only works if two missions about the same market land on
 * the *same string*. Free text never does. Production proves it — of the 118
 * missions on 2026-08-31, 15 carried a user-typed `category` and they held 14
 * distinct values:
 *
 *   "premium subscription coffee" · "mobile fitness app" · "Market research"
 *   "Personal finance app, FinTech, B2C SaaS" · "QR code for restaurants in Syria"
 *   "B2B SaaS, project management, productivity software" · ...
 *
 * Fourteen buckets of one. Zero benchmarking value. So the model picks from a
 * CLOSED list and anything it invents is coerced to `other`.
 *
 * DESIGN RULES (why it looks like this)
 * ─────────────────────────────────────
 * 1. ONE constant. MISSION_CATEGORIES below is the whole taxonomy — keys,
 *    display labels, and the scope hints that go into the prompt. Edit the
 *    array and the prompt, the validator and the tests all move together.
 *    Nothing else in the codebase may hard-code a category string.
 * 2. Machine keys, not display strings. `food_beverage`, never "F&B". A key
 *    is a join key for historical rows; relabelling "F&B" → "Food & Drink"
 *    later must not orphan two years of missions.
 * 3. Modest width. 15 real buckets + `other`. Wider buckets give thin
 *    benchmarks (at ~118 missions, 30 categories would average 4 rows each);
 *    narrower ones lump unlike markets together. 15 keeps most buckets
 *    plausibly populated while still separating markets that genuinely
 *    behave differently (telco vs. fintech vs. F&B).
 * 4. An explicit escape hatch. `other` is a legitimate answer, not a failure
 *    code — it is far better than the model forcing a bad fit. The count of
 *    `other` is the signal for when the taxonomy needs a new bucket.
 * 5. One tie-break rule, stated in the prompt: classify by the END MARKET the
 *    respondent buys in, NOT the delivery mechanism. A meal-kit app is
 *    food_beverage (not software_saas, not retail_ecommerce); a banking app
 *    is fintech_financial_services; a telehealth app is health_wellness.
 *    Without this rule every app-shaped brief collapses into software_saas
 *    and the benchmark is worthless.
 *
 * THE OWNER MAY WANT TO CHANGE THIS LIST. That is expected — it is deliberately
 * one editable array. Adding a key is safe. RENAMING or REMOVING a key strands
 * already-stamped rows, so do that with a backfill, not an edit.
 */

/**
 * The taxonomy. `key` is what lands in missions.category. `label` is for UI.
 * `includes` is prompt-facing scope text — it is the main defence against two
 * similar briefs drifting into different buckets, so keep it concrete.
 */
const MISSION_CATEGORIES = [
  { key: 'food_beverage', label: 'Food & Beverage',
    includes: 'restaurants, cafes, packaged food, snacks, confectionery, soft drinks, coffee, tea, energy drinks, bottled water, alcohol, dairy, groceries and supermarkets, meal kits, food delivery' },
  { key: 'beauty_personal_care', label: 'Beauty & Personal Care',
    includes: 'skincare, cosmetics, haircare, fragrance, shaving, oral care, deodorant, personal hygiene, salons and barbers' },
  { key: 'fashion_apparel', label: 'Fashion & Apparel',
    includes: 'clothing, footwear, sportswear, accessories, jewellery, watches, eyewear, luxury fashion, resale' },
  { key: 'retail_ecommerce', label: 'Retail & E-commerce',
    includes: 'general marketplaces, department and convenience stores, home goods, furniture, appliances, kitchenware, decor, toys, pet supplies, subscription boxes with mixed assortments' },
  { key: 'consumer_electronics', label: 'Consumer Electronics',
    includes: 'phones, laptops, tablets, wearables, audio, TVs, cameras, gaming hardware, smart-home devices, accessories' },
  { key: 'software_saas', label: 'Software & SaaS',
    includes: 'B2B software, developer tools, productivity and collaboration apps, CRM, analytics, cybersecurity, AI tools, IT infrastructure — only when the SOFTWARE ITSELF is the product being bought' },
  { key: 'fintech_financial_services', label: 'Fintech & Financial Services',
    includes: 'banking, neobanks, payments, wallets, cards, lending, BNPL, insurance, investing and trading, crypto, remittances, accounting and tax for consumers' },
  { key: 'health_wellness', label: 'Health & Wellness',
    includes: 'healthcare providers, clinics, pharma and OTC, medical devices, telehealth, mental health, fitness and gyms, supplements, nutrition, sleep, femtech' },
  { key: 'travel_hospitality', label: 'Travel & Hospitality',
    includes: 'airlines, hotels, short-term rentals, OTAs and booking, cruises, tourism boards, car rental for travel, restaurants-as-destination experiences, events and attractions' },
  { key: 'telecom', label: 'Telecom',
    includes: 'mobile network operators, broadband and fibre, prepaid and postpaid plans, roaming, satellite and fixed-line connectivity' },
  { key: 'automotive_mobility', label: 'Automotive & Mobility',
    includes: 'cars, EVs, dealerships, aftermarket parts and servicing, motorcycles, ride-hailing, car sharing, micromobility, public transit, last-mile logistics and courier' },
  { key: 'education', label: 'Education',
    includes: 'schools, universities, edtech, online courses, tutoring, test prep, professional certification, corporate training, childcare and early years' },
  { key: 'media_entertainment', label: 'Media & Entertainment',
    includes: 'streaming video and music, TV and film, news and publishing, podcasts, social platforms, video games and esports, sports leagues and clubs, betting and gaming, creator platforms' },
  { key: 'real_estate_property', label: 'Real Estate & Property',
    includes: 'residential and commercial property, developers, brokerage and listings portals, rentals, property management, mortgages tied to a specific property offer, construction and home improvement services' },
  { key: 'professional_services', label: 'Professional & Industrial Services',
    includes: 'consulting, agencies, legal, accounting firms, recruitment and staffing, B2B logistics and manufacturing, energy and utilities, agriculture, government and public sector, NGOs' },
  { key: 'other', label: 'Other',
    includes: 'nothing above is a reasonable fit. A legitimate answer — never force a bad fit.' },
];

/** Fallback used whenever classification is absent, unrecognised or unusable. */
const FALLBACK_CATEGORY = 'other';

/** Set of valid keys, derived — never hand-maintained. */
const CATEGORY_KEYS = MISSION_CATEGORIES.map((c) => c.key);
const CATEGORY_KEY_SET = new Set(CATEGORY_KEYS);

/** label (lowercased) → key, so a model that answers "Food & Beverage" still lands. */
const LABEL_TO_KEY = new Map(
  MISSION_CATEGORIES.map((c) => [c.label.toLowerCase(), c.key]),
);

/**
 * A handful of high-traffic aliases the model (or a human) is likely to emit
 * instead of the canonical key. Deliberately SHORT: this is a safety net, not
 * a second taxonomy. Anything not here falls through to `other`, which is the
 * honest outcome.
 */
const ALIASES = new Map(Object.entries({
  f_and_b: 'food_beverage',
  fandb: 'food_beverage',
  fnb: 'food_beverage',
  f_b: 'food_beverage',
  food: 'food_beverage',
  beverage: 'food_beverage',
  fmcg: 'food_beverage',
  cpg: 'food_beverage',
  beauty: 'beauty_personal_care',
  personal_care: 'beauty_personal_care',
  cosmetics: 'beauty_personal_care',
  fashion: 'fashion_apparel',
  apparel: 'fashion_apparel',
  retail: 'retail_ecommerce',
  ecommerce: 'retail_ecommerce',
  e_commerce: 'retail_ecommerce',
  electronics: 'consumer_electronics',
  saas: 'software_saas',
  software: 'software_saas',
  tech: 'software_saas',
  b2b_saas: 'software_saas',
  fintech: 'fintech_financial_services',
  finance: 'fintech_financial_services',
  financial_services: 'fintech_financial_services',
  banking: 'fintech_financial_services',
  insurance: 'fintech_financial_services',
  health: 'health_wellness',
  healthcare: 'health_wellness',
  wellness: 'health_wellness',
  pharma: 'health_wellness',
  travel: 'travel_hospitality',
  hospitality: 'travel_hospitality',
  telco: 'telecom',
  telecoms: 'telecom',
  telecommunications: 'telecom',
  automotive: 'automotive_mobility',
  auto: 'automotive_mobility',
  mobility: 'automotive_mobility',
  edtech: 'education',
  media: 'media_entertainment',
  entertainment: 'media_entertainment',
  gaming: 'media_entertainment',
  real_estate: 'real_estate_property',
  property: 'real_estate_property',
  proptech: 'real_estate_property',
  professional_services: 'professional_services',
  b2b_services: 'professional_services',
  energy: 'professional_services',
  utilities: 'professional_services',
  unknown: FALLBACK_CATEGORY,
  none: FALLBACK_CATEGORY,
  n_a: FALLBACK_CATEGORY,
}));

/**
 * Coerce anything the model (or an API caller) produced into a valid key.
 *
 * This is the ONLY sanctioned way to turn an untrusted string into a value
 * written to missions.category. It never throws and never returns null — an
 * unrecognised or missing value becomes FALLBACK_CATEGORY, because a mission
 * with a wrong-but-shared bucket is still benchmarkable and a mission with a
 * bespoke string is not.
 *
 * @param {unknown} raw
 * @returns {string} one of CATEGORY_KEYS
 */
function normalizeCategory(raw) {
  if (typeof raw !== 'string') return FALLBACK_CATEGORY;
  const trimmed = raw.trim();
  if (!trimmed) return FALLBACK_CATEGORY;

  // Fast path: already canonical.
  if (CATEGORY_KEY_SET.has(trimmed)) return trimmed;

  // Human label, any case ("Food & Beverage").
  const labelHit = LABEL_TO_KEY.get(trimmed.toLowerCase());
  if (labelHit) return labelHit;

  // Slug: lowercase, collapse every non-alphanumeric run to a single "_".
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) return FALLBACK_CATEGORY;
  if (CATEGORY_KEY_SET.has(slug)) return slug;
  if (ALIASES.has(slug)) return ALIASES.get(slug);

  return FALLBACK_CATEGORY;
}

/** True when `value` is already a canonical taxonomy key. */
function isMissionCategory(value) {
  return typeof value === 'string' && CATEGORY_KEY_SET.has(value);
}

/** Display label for a key (falls back to the key itself). */
function categoryLabel(key) {
  const hit = MISSION_CATEGORIES.find((c) => c.key === key);
  return hit ? hit.label : String(key);
}

/**
 * The prompt fragment. Generated from MISSION_CATEGORIES so the instruction
 * and the validator can never disagree about what the valid keys are.
 *
 * Appended to an EXISTING system prompt — this module deliberately owns no
 * Claude call of its own, so classification is always a rider on a call the
 * flow was already making.
 */
const CATEGORY_PROMPT_BLOCK = [
  'Also classify the brief into exactly ONE market category, for benchmarking.',
  '',
  'Choose the single best key from this closed list. Return the KEY EXACTLY as written — never invent a key, never return a label, never return more than one:',
  ...MISSION_CATEGORIES.map((c) => `- ${c.key} — ${c.includes}`),
  '',
  'Tie-break rule (apply it every time): classify by the END MARKET the respondent is buying in, NOT by the delivery mechanism or business model.',
  '  · a meal-kit or food-delivery app → food_beverage (NOT software_saas, NOT retail_ecommerce)',
  '  · a banking or budgeting app → fintech_financial_services',
  '  · a telehealth or fitness app → health_wellness',
  '  · a hotel booking app → travel_hospitality',
  '  · software_saas is ONLY for products where the software itself is what the buyer is evaluating.',
  'If genuinely nothing fits, answer other. That is a valid answer — do not force a bad fit.',
].join('\n');

module.exports = {
  MISSION_CATEGORIES,
  CATEGORY_KEYS,
  FALLBACK_CATEGORY,
  CATEGORY_PROMPT_BLOCK,
  normalizeCategory,
  isMissionCategory,
  categoryLabel,
};
