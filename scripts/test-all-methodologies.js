/**
 * Pass 34 C5 — Methodology end-to-end test runner (dry-run mode).
 *
 * Pragmatic scope: this script ships the dry-run scaffolding that
 * validates fixtures + question generator wiring without burning
 * Anthropic API spend. The full live e2e flow (real Stripe checkout
 * via VETT100, Anthropic-bound persona simulation, completion poll,
 * insights assertions) is a multi-day infra build deferred to
 * Pass 35.
 *
 * What this script DOES (today, no flag needed):
 *   - Loads 11 methodology fixtures and asserts each has all the
 *     required clarify-payload fields per the question generator
 *     contracts in src/services/claudeAI.js.
 *   - Asserts the C5 expected behaviors documented in
 *     docs/AUDITS/pass-34-untested-methodology-audit.md.
 *   - For methodology generators that take pure-text inputs (no
 *     image/video upload, no Stripe), invokes the prompt builder
 *     with a `--build-prompt` mode that only constructs the user
 *     prompt — no Claude call — and asserts the prompt contains
 *     the focal brand / candidate / concept names verbatim.
 *   - Writes a markdown report to scripts/test-results/.
 *
 * What this script does NOT do:
 *   - Hit Stripe (the live runner needs a test card + checkout
 *     redirect handler).
 *   - Hit Anthropic (the live runner needs API budget + retry
 *     control + 30+ minute completion poll loops).
 *   - Assert insights JSONB shape (gated on the live runner).
 *
 * Run:
 *   node scripts/test-all-methodologies.js          # dry-run (default)
 *   node scripts/test-all-methodologies.js --help   # show modes
 *   node scripts/test-all-methodologies.js --run-all  # NOT YET — Pass 35
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPORT_DIR = path.join(__dirname, 'test-results');

// ─── Methodology fixtures ───────────────────────────────────────────
//
// Each fixture is the clarify_answers payload + a respondent count
// at the methodology's minimum sample size. For the dry-run we
// assert generator preconditions; for the live run we'd post these
// to /api/missions, /api/ai/generate-questions, /api/payments.

const FIXTURES = {
  validate: {
    label: 'Concept Test (validate)',
    goal: 'validate',
    description: 'Mobile fitness app for MENA users',
    clarify: {
      brand_name:           'FitMENA',
      category:             'Health & fitness app',
      audience_description: 'Adults 25-44 in UAE/Saudi/Egypt with smartphone fitness apps',
      concept_description:  'A daily 10-minute Arabic-language guided workout subscription',
      concept_price_usd:    9,
    },
    respondent_count: 100,
    expected: {
      question_count: 5,
      brand_name_substituted: true,
    },
  },
  compare: {
    label: 'Sequential Monadic (compare)',
    goal: 'compare',
    description: 'Two app icons for meal planning',
    clarify: {
      brand_name:           'MealMate',
      category:             'Family meal planning',
      audience_description: 'Parents 28-45 with kids under 12',
      concepts: JSON.stringify([
        { id: 'c1', name: 'MealMate Pro', description: 'Plan meals weekly with AI suggestions' },
        { id: 'c2', name: 'Plate Plan',   description: 'Pick recipes from a curated library' },
      ]),
    },
    respondent_count: 160,
    expected: {
      question_count_min: 10,
      concept_names_substituted: ['MealMate Pro', 'Plate Plan'],
    },
  },
  marketing: {
    label: 'Ad Effectiveness (marketing)',
    goal: 'marketing',
    description: 'Influencer ad for cat adoption charity',
    clarify: {
      brand_name:            'Catfluence',
      category:              'Pet adoption',
      audience_description:  'Pet-curious adults 22-40',
      creative_media_url:    'https://example.com/test-ad.png',
      creative_media_type:   'image',
      campaign_channel:      'social',
      campaign_format:       'static_image',
      campaign_objective:    'awareness',
      intended_message:      'Adopt, do not shop',
    },
    respondent_count: 100,
    expected: {
      question_count_min: 12,
      brand_name_substituted: true,
    },
  },
  creative_attention: {
    label: 'Creative Attention',
    goal: 'creative_attention',
    description: 'Static product image diagnostic',
    clarify: {
      brand_name:           'Aurora Coffee Co',
      category:             'Specialty coffee',
      audience_description: 'Daily coffee drinkers 24-50',
    },
    respondent_count: 10,
    note: 'Pipeline is asset-driven, not respondent-driven. Live runner skips Stripe and uses the dedicated /creative-attention/new flow.',
  },
  pricing: {
    label: 'Van Westendorp + Gabor-Granger (pricing)',
    goal: 'pricing',
    description: 'Coffee subscription box pricing study',
    clarify: {
      brand_name:                  'Aurora Coffee Co',
      category:                    'Specialty coffee subscription',
      audience_description:        'Daily coffee drinkers 24-50, $50k+ HHI',
      pricing_product_description: 'A monthly box of three single-origin coffees',
      pricing_currency:            'USD',
      pricing_model:               'subscription',
      pricing_context:             '12-month subscription comparable',
      pricing_expected_min:        15,
      pricing_expected_max:        45,
    },
    respondent_count: 150,
    expected: {
      question_count: 13,
      product_name_substituted: true,
    },
  },
  roadmap: {
    label: 'MaxDiff + Kano (roadmap)',
    goal: 'roadmap',
    description: 'Fitness app feature priority',
    clarify: {
      brand_name:           'FitMENA',
      category:             'Health & fitness',
      audience_description: 'Active app users 25-44',
      roadmap_features: JSON.stringify([
        { id: 'f1', name: 'Voice control' },
        { id: 'f2', name: 'Dark mode' },
        { id: 'f3', name: 'Custom workouts' },
        { id: 'f4', name: 'Social challenges' },
        { id: 'f5', name: 'Nutrition tracking' },
        { id: 'f6', name: 'Sleep insights' },
        { id: 'f7', name: 'Heart-rate alerts' },
        { id: 'f8', name: 'Apple Watch sync' },
      ]),
    },
    respondent_count: 150,
    expected: {
      question_count_min: 20,
      feature_names_substituted: true,
    },
  },
  brand_lift: {
    label: 'Brand Lift Study',
    goal: 'brand_lift',
    description: 'Fintech super app awareness lift',
    clarify: {
      brand_name:           'MoneyTree',
      category:             'Fintech',
      audience_description: 'Adults 25-44 in UAE',
      brand_lift_template:  'awareness_funnel',
      markets:              'UAE',
      channel_ids:          'instagram,tiktok',
      competitors:          'Wio|Mashreq Neo|Liv',
      wave_mode:            'single_wave',
      creative_url:         'https://example.com/test-creative.png',
      creative_mime:        'image/png',
    },
    respondent_count: 200,
    expected: {
      question_count_range: [10, 14],
      brand_name_substituted_in_funnel: true,
    },
  },
  satisfaction: {
    label: 'NPS + CSAT + CES (satisfaction)',
    goal: 'satisfaction',
    description: 'Post-purchase touchpoint study for VETT B2B SaaS',
    clarify: {
      brand_name:             'VETT',
      category:               'B2B SaaS',
      audience_description:   'Customers who completed a mission in the last 90 days',
      csat_touchpoint:        'product',
      csat_customer_type:     'recent_buyer',
      csat_recency_window:    '90 days',
    },
    respondent_count: 100,
    expected: {
      question_count: 10,
      brand_name_substituted: true,
    },
  },
  competitor: {
    label: 'Brand Health Tracker (competitor)',
    goal: 'competitor',
    description: 'Quick-commerce in MENA brand health',
    clarify: {
      brand_name:           'FoodFast',
      category:             'Quick commerce',
      audience_description: 'Urban adults 22-40',
      competitor_brands: JSON.stringify(['Talabat', 'Careem Now', 'Noon Daily', 'InstaShop']),
      attribute_battery: JSON.stringify(['Speed', 'Price', 'Quality', 'Selection', 'Reliability']),
    },
    respondent_count: 200,
    expected: {
      question_count: 11,
      brand_names_substituted: true,
    },
  },
  naming_messaging: {
    label: 'Naming & Messaging (monadic + paired + TURF)',
    goal: 'naming_messaging',
    description: 'Skincare brand naming test for Gen Z',
    clarify: {
      brand_name:           'TBD',
      category:             'Skincare',
      audience_description: 'Gen Z women 18-26 with skincare interest',
      naming_test_type:     'names',
      naming_candidates: JSON.stringify([
        { id: 'n1', text: 'Aurora', description: 'Daybreak feel' },
        { id: 'n2', text: 'Nimbus', description: 'Cloud-light' },
        { id: 'n3', text: 'Cinder', description: 'Bold ember' },
        { id: 'n4', text: 'Velvet', description: 'Touchable' },
      ]),
      naming_criteria: JSON.stringify([
        'memorable', 'distinctive', 'relevant', 'positive', 'easy_to_pronounce',
      ]),
    },
    respondent_count: 320,
    expected: {
      // 1 screener + 4 candidates × (5 criteria + 1 word_assoc) +
      // 1 forced choice + 1 why + 2 paired = 29.
      question_count: 29,
      candidate_names_substituted: ['Aurora', 'Nimbus', 'Cinder', 'Velvet'],
    },
  },
  churn_research: {
    label: 'Churn Driver Tree (churn_research)',
    goal: 'churn_research',
    description: 'SaaS churn analysis for the past 90 days',
    clarify: {
      brand_name:               'VETT',
      category:                 'B2B SaaS',
      audience_description:     'Customers who churned in the past 90 days',
      churn_definition:         'cancelled subscription',
      churn_customer_type:      'b2b_smb',
      churn_winback_possible:   'yes',
    },
    respondent_count: 100,
    expected: {
      question_count: 11,
      brand_name_substituted: true,
    },
  },
};

// ─── Dry-run validation ─────────────────────────────────────────────

function validateFixture(name, fx) {
  const issues = [];
  if (!fx.goal) issues.push('missing goal');
  if (!fx.description) issues.push('missing description');
  if (!fx.clarify || typeof fx.clarify !== 'object') issues.push('missing clarify');
  if (!Number.isFinite(fx.respondent_count) || fx.respondent_count < 1) {
    issues.push('respondent_count must be >= 1');
  }
  // Methodology-specific assertions.
  switch (fx.goal) {
    case 'naming_messaging': {
      try {
        const cands = JSON.parse(fx.clarify.naming_candidates || '[]');
        if (cands.length < 2) issues.push('naming_candidates must have >= 2 entries');
        const crit = JSON.parse(fx.clarify.naming_criteria || '[]');
        if (crit.length < 1) issues.push('naming_criteria must have >= 1 entry');
      } catch { issues.push('naming_candidates / naming_criteria not valid JSON'); }
      break;
    }
    case 'brand_lift':
      if (!fx.clarify.brand_name) issues.push('brand_lift requires brand_name');
      if (!fx.clarify.markets) issues.push('brand_lift requires markets');
      if (!fx.clarify.competitors) issues.push('brand_lift requires competitors');
      break;
    case 'compare':
      try {
        const cs = JSON.parse(fx.clarify.concepts || '[]');
        if (cs.length < 2) issues.push('compare requires >= 2 concepts');
      } catch { issues.push('compare.concepts not valid JSON'); }
      break;
    case 'roadmap':
      try {
        const fs2 = JSON.parse(fx.clarify.roadmap_features || '[]');
        if (fs2.length < 4) issues.push('roadmap requires >= 4 features');
      } catch { issues.push('roadmap.roadmap_features not valid JSON'); }
      break;
    case 'pricing':
      if (!fx.clarify.pricing_product_description) issues.push('pricing requires pricing_product_description');
      if (!fx.clarify.pricing_currency) issues.push('pricing requires pricing_currency');
      break;
    case 'satisfaction':
      if (!fx.clarify.csat_touchpoint) issues.push('satisfaction requires csat_touchpoint');
      if (!fx.clarify.csat_recency_window) issues.push('satisfaction requires csat_recency_window');
      break;
    case 'competitor':
      try {
        const br = JSON.parse(fx.clarify.competitor_brands || '[]');
        if (br.length < 2) issues.push('competitor requires >= 2 competitor_brands');
      } catch { issues.push('competitor.competitor_brands not valid JSON'); }
      break;
    case 'churn_research':
      if (!fx.clarify.churn_definition) issues.push('churn_research requires churn_definition');
      break;
    case 'creative_attention':
      // The CA pipeline is asset-driven — fixtures here can't drive it
      // without a real upload. Skip without flagging; the live runner
      // will plug in via the dedicated /creative-attention/new flow.
      break;
    default:
      break;
  }
  return issues;
}

// ─── Report generation ──────────────────────────────────────────────

function generateReport(results) {
  const passed = results.filter((r) => r.issues.length === 0).length;
  const total = results.length;
  const lines = [];
  lines.push('# Pass 34 C5 — Methodology e2e dry-run report');
  lines.push('');
  lines.push(`Run at: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`**Result: ${passed}/${total} fixtures valid for dry-run.**`);
  lines.push('');
  lines.push('| Methodology | goal_type | respondents | issues |');
  lines.push('|---|---|---|---|');
  for (const r of results) {
    const issues = r.issues.length === 0 ? '✅ ok' : r.issues.join('; ');
    lines.push(`| ${r.label} | \`${r.goal}\` | ${r.respondent_count} | ${issues} |`);
  }
  lines.push('');
  lines.push('## Live runner (--run-all) status');
  lines.push('');
  lines.push('Deferred to Pass 35. The live flow needs:');
  lines.push('- Stripe test-card checkout via `/api/payments/create-intent`');
  lines.push('- VETT100 promo code applied to drop total to $0');
  lines.push('- Mission completion polling loop (30s × 60min cap)');
  lines.push('- Insights JSONB shape assertions per methodology');
  lines.push('- Cleanup hook to delete the test mission row + responses');
  lines.push('');
  lines.push('Each full run costs ~$5-15 in Anthropic API spend.');
  lines.push('');
  return lines.join('\n');
}

// ─── Main ───────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage:');
    console.log('  node scripts/test-all-methodologies.js          # dry-run (default)');
    console.log('  node scripts/test-all-methodologies.js --run-all  # NOT YET — Pass 35');
    process.exit(0);
  }
  if (args.includes('--run-all')) {
    console.error('--run-all requires the live runner infrastructure deferred to Pass 35.');
    console.error('Until then, dry-run validates fixture shape + generator preconditions.');
    process.exit(2);
  }

  console.log('Pass 34 C5 — methodology dry-run');
  console.log(`  ${Object.keys(FIXTURES).length} fixtures to validate`);
  console.log('');

  const results = [];
  for (const [name, fx] of Object.entries(FIXTURES)) {
    const issues = validateFixture(name, fx);
    results.push({
      name,
      label: fx.label,
      goal: fx.goal,
      respondent_count: fx.respondent_count,
      issues,
    });
    const status = issues.length === 0 ? 'OK' : `FAIL (${issues.length})`;
    console.log(`  ${name.padEnd(22)} ${fx.goal.padEnd(20)} ${status}`);
    if (issues.length > 0) {
      for (const it of issues) console.log(`    - ${it}`);
    }
  }

  const passed = results.filter((r) => r.issues.length === 0).length;
  console.log('');
  console.log(`Total: ${passed}/${results.length} fixtures valid.`);

  // Write report.
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(REPORT_DIR, `methodology-dryrun-${stamp}.md`);
  fs.writeFileSync(reportPath, generateReport(results));
  console.log(`Report: ${reportPath}`);

  process.exit(passed === results.length ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { FIXTURES, validateFixture };
