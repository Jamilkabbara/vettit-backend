#!/usr/bin/env node
/**
 * DRY RUN - what aligning ai_spend_ceiling_usd on the list price actually moves.
 *
 * READ ONLY. This script issues SELECTs and nothing else. It writes no row, no
 * column and no migration. Run it before and after the change and compare.
 *
 * WHAT IT PRINTS
 *   1. REAL MISSIONS. Every mission that carries a price, with the ceiling the
 *      row holds today next to the ceiling the list basis would give it. The
 *      list basis is reconstructed the way the trigger would have to:
 *      total_price_usd + discount_usd.
 *   2. THE FORWARD MATRIX. The same comparison over the shapes a customer can
 *      actually buy, priced through the real engine with a real promo object.
 *      This is where the size of the change lives - see the note printed under
 *      the table about why part 1 comes back quiet.
 *
 * Usage:  node scripts/dryrun-spend-ceiling-basis.js
 * Needs:  SUPABASE_URL and SUPABASE_SERVICE_KEY for part 1. Part 2 needs
 *         nothing and runs regardless, so the arithmetic is checkable with no
 *         database access at all.
 */
'use strict';

require('dotenv').config();

const {
  calculateMissionPrice,
  aiSpendCeilingUsd,
  listPriceUsd,
  AI_SPEND_CEILING_FRACTION,
} = require('../src/utils/pricingEngine');

const usd = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '-' : `$${Number(n).toFixed(2)}`);
const pad = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);

/** The basis the ceiling USED to come from on the checkout paths. */
const postPromoCeiling = (chargedTotal) => aiSpendCeilingUsd(Number(chargedTotal));

// ── Part 1: real missions, read only ────────────────────────────────────────

async function realMissions() {
  console.log('\n=== 1. PRODUCTION MISSIONS (read only) ===\n');

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.log('  SUPABASE_URL / SUPABASE_SERVICE_KEY not set - skipping part 1.');
    return;
  }

  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data, error } = await supabase
    .from('missions')
    .select('id, goal_type, status, respondent_count, total_price_usd, discount_usd, promo_code, ai_spend_ceiling_usd, target_qualified_count, created_at')
    .order('created_at', { ascending: false })
    .limit(1000);

  if (error) {
    console.log(`  read failed: ${error.message}`);
    return;
  }

  console.log(`  rows read: ${data.length}`);

  const priced = data.filter((m) => Number(m.total_price_usd) > 0);
  const discounted = data.filter((m) => Number(m.discount_usd) > 0);
  const promoed = data.filter((m) => m.promo_code);

  console.log(`  with a price:        ${priced.length}`);
  console.log(`  with a promo_code:   ${promoed.length}  (${[...new Set(promoed.map((m) => m.promo_code))].join(', ') || 'none'})`);
  console.log(`  with discount_usd>0: ${discounted.length}`);
  console.log('');

  const head = `  ${pad('mission', 10)}${pad('goal', 20)}${pad('n', 6)}${padL('charged', 10)}${padL('discount', 10)}${padL('ceiling now', 13)}${padL('list basis', 12)}${padL('delta', 10)}`;
  console.log(head);
  console.log(`  ${'-'.repeat(head.length - 2)}`);

  let moved = 0;
  for (const m of priced.slice(0, 40)) {
    const charged = Number(m.total_price_usd);
    const disc = Number(m.discount_usd) || 0;
    const listBasis = aiSpendCeilingUsd(charged + disc);
    const now = Number(m.ai_spend_ceiling_usd);
    const delta = Number.isFinite(now) ? listBasis - now : null;
    if (delta && Math.abs(delta) > 0.0001) moved += 1;
    console.log(`  ${pad(m.id.slice(0, 8), 10)}${pad(m.goal_type || '-', 20)}${pad(m.respondent_count ?? '-', 6)}${padL(usd(charged), 10)}${padL(usd(disc), 10)}${padL(usd(now), 13)}${padL(usd(listBasis), 12)}${padL(delta === null ? '-' : usd(delta), 10)}`);
  }

  console.log('');
  console.log(`  rows whose ceiling would move: ${moved} of ${Math.min(priced.length, 40)} shown`);
  if (!discounted.length) {
    console.log('');
    console.log('  NOTE, and it is the headline of part 1: no mission in production carries a');
    console.log('  non-zero discount_usd. The only promo codes ever used are free-type, and');
    console.log('  the free-launch path already priced the ceiling off the list. So this');
    console.log('  change moves NO existing row. It is forward-looking: it changes what the');
    console.log('  next percentage or flat-code purchase gets. Part 2 is where to look for');
    console.log('  the size of that.');
  }
}

// ── Part 2: the forward matrix ──────────────────────────────────────────────

const HALF = { code: 'HALFOFF', active: true, type: 'percentage', value: 50 };
const QUARTER = { code: 'QUARTER', active: true, type: 'percentage', value: 25 };
const TENFLAT = { code: 'TENOFF', active: true, type: 'flat', value: 10 };
const FREE = { code: 'FREELAUNCH', active: true, type: 'free' };

const SHAPES = [
  { label: 'validate n=50', inputs: { respondentCount: 50, goalType: 'validate' } },
  { label: 'validate n=100', inputs: { respondentCount: 100, goalType: 'validate' } },
  { label: 'validate n=300', inputs: { respondentCount: 300, goalType: 'validate' } },
  { label: 'research n=500', inputs: { respondentCount: 500, goalType: 'research' } },
  { label: 'compare n=240', inputs: { respondentCount: 240, goalType: 'compare' } },
  { label: 'creative image n=10', inputs: { respondentCount: 10, goalType: 'creative_attention', mediaType: 'image' } },
  { label: 'creative video n=10', inputs: { respondentCount: 10, goalType: 'creative_attention', mediaType: 'video' } },
  { label: 'brand_lift n=300', inputs: { respondentCount: 300, goalType: 'brand_lift' } },
];

const PROMOS = [
  { label: 'no code', promo: undefined },
  { label: '25% off', promo: QUARTER },
  { label: '50% off', promo: HALF },
  { label: '$10 flat', promo: TENFLAT },
  { label: 'free', promo: FREE },
];

function forwardMatrix() {
  console.log('\n=== 2. FORWARD MATRIX - every buyable shape x every promo type ===\n');
  console.log(`  ceiling fraction: ${AI_SPEND_CEILING_FRACTION} of the basis\n`);

  const head = `  ${pad('shape', 22)}${pad('code', 11)}${padL('list', 8)}${padL('charged', 10)}${padL('BEFORE', 10)}${padL('AFTER', 10)}${padL('change', 12)}`;
  console.log(head);
  console.log(`  ${'-'.repeat(head.length - 2)}`);

  for (const shape of SHAPES) {
    for (const { label, promo } of PROMOS) {
      const pricing = calculateMissionPrice({
        targeting: {}, questionCount: 0, countries: [], ...shape.inputs, promoCode: promo,
      });
      const list = listPriceUsd(pricing);
      const before = postPromoCeiling(pricing.total);   // 30% of the CHARGE
      const after = aiSpendCeilingUsd(pricing);         // 30% of the LIST
      const change = before === 0
        ? (after > 0 ? '0 -> runs' : 'no change')
        : (after === before ? 'no change' : `${((after / before - 1) * 100).toFixed(0)}%`);
      console.log(`  ${pad(shape.label, 22)}${pad(label, 11)}${padL(usd(list), 8)}${padL(usd(pricing.total), 10)}${padL(usd(before), 10)}${padL(usd(after), 10)}${padL(change, 12)}`);
    }
    console.log('');
  }

  console.log('  Read the "free" rows carefully. BEFORE is $0, which runMission refuses');
  console.log('  outright - that is why free-launch already computed a no-promo quote by');
  console.log('  hand. The percentage and flat rows are the ones that were silently wrong:');
  console.log('  they produced a positive ceiling, so nothing ever complained, and the run');
  console.log('  simply had less budget than the work needed.');
}

(async () => {
  console.log('DRY RUN - ai_spend_ceiling_usd basis: charged total vs no-promo list price');
  console.log('Read-only. No writes of any kind.');
  forwardMatrix();
  await realMissions();
  console.log('');
})().catch((err) => { console.error(err); process.exit(1); });
