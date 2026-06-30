#!/usr/bin/env node
/**
 * P0-7 — audit + close promo-code revenue leaks.
 *
 *   node scripts/fix-promo-leaks.js            # DRY RUN: audit only, no writes
 *   node scripts/fix-promo-leaks.js --apply    # apply fixes to DB + Stripe
 *
 * A promo can be redeemed two ways, so closing a leak takes BOTH:
 *   1) our promo_codes table (our /api/pricing/quote path), and
 *   2) the synced Stripe promotion code (checkout has allow_promotion_codes:true,
 *      so a customer can type the code on Stripe's page directly).
 * Disabling only the DB row leaves the Stripe code redeemable. This script does
 * both: sets active=false on the DB row AND deactivates the Stripe promotion
 * code(s) for that code (the underlying coupon is left intact so historical
 * redemptions and reporting are unaffected — only NEW redemptions stop).
 *
 * Targeted fixes (from the launch audit):
 *   VETT100    100%-off, active, no cap, no expiry  -> DISABLE (uncapped free money)
 *   FRIEND10   $10 flat off on a $9 product         -> DISABLE (drives charge <= $0;
 *                                                       no min-order column exists.
 *                                                       Re-introduce as a % or after a
 *                                                       min-order guard ships in PR A.)
 *   VETT20     expired (2026-06-30)                 -> DISABLE (retire cleanly)
 *   PASS44TEST junk test code                       -> DISABLE (+ optional hard delete)
 *
 * Every OTHER active code is reported with a risk read (e.g. uncapped %), but is
 * NOT auto-touched — you decide. Re-run after PR A to re-validate against the new
 * base prices.
 *
 * Env (.env): SUPABASE_URL, SUPABASE_SERVICE_KEY[,_ROLE_KEY], STRIPE_SECRET_KEY.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const APPLY = process.argv.includes('--apply');
const HARD_DELETE_TEST = process.argv.includes('--hard-delete-test'); // also DELETE PASS44TEST row

// code -> reason. These are the audit's confirmed leaks.
const TARGETS = {
  VETT100:    'uncapped 100%-off, active, no expiry',
  FRIEND10:   'flat $10 off applies to a $9 product (charge <= $0); no min-order guard',
  VETT20:     'expired; retire so it cannot be reactivated by accident',
  PASS44TEST: 'internal test code in production',
};

function riskOf(p) {
  const now = Date.now();
  const expired = p.expires_at && new Date(p.expires_at).getTime() < now;
  const exhausted = p.max_uses != null && (p.uses_count || 0) >= p.max_uses;
  // Live rows use type 'free' for 100%-off (schema's percentage/flat CHECK is
  // looser in prod); treat it as 100% for the risk read.
  const pct = p.type === 'percentage' ? Number(p.value) : (p.type === 'free' ? 100 : null);
  const risks = [];
  if (pct === 100) risks.push('100%-OFF (free)');
  if (pct != null && pct >= 50) risks.push(`high ${pct}%`);
  if (p.type === 'flat' && Number(p.value) >= 9) risks.push(`flat $${p.value} >= entry price`);
  if (p.max_uses == null && p.active && !expired) risks.push('UNCAPPED (no max_uses)');
  if (p.expires_at == null && p.active) risks.push('no expiry');
  if (expired) risks.push('EXPIRED');
  if (exhausted) risks.push('exhausted');
  return { expired, exhausted, risks };
}

async function deactivateStripe(stripe, code) {
  if (!stripe) return '(no STRIPE_SECRET_KEY — skipped Stripe)';
  try {
    const list = await stripe.promotionCodes.list({ code, limit: 100 });
    const active = (list.data || []).filter((pc) => pc.active);
    if (!active.length) return 'no active Stripe promotion code';
    if (!APPLY) return `${active.length} active Stripe promotion code(s) WOULD be deactivated`;
    for (const pc of active) await stripe.promotionCodes.update(pc.id, { active: false });
    return `deactivated ${active.length} Stripe promotion code(s)`;
  } catch (e) {
    return `Stripe error: ${e.message}`;
  }
}

(async () => {
  const url = process.env.SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) throw new Error('Need SUPABASE_URL + SUPABASE_SERVICE_KEY in .env');
  const db = createClient(url, service, { auth: { persistSession: false } });

  let stripe = null;
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }

  const { data: rows, error } = await db.from('promo_codes').select('*').order('code');
  if (error) throw new Error(`read promo_codes failed: ${error.message}`);

  console.log(`\nMODE: ${APPLY ? 'APPLY (writing DB + Stripe)' : 'DRY RUN (no writes)'}`);
  console.log(`Stripe: ${stripe ? 'connected' : 'NOT connected (DB only)'}\n`);
  console.log(`${rows.length} promo codes in promo_codes:\n`);

  for (const p of rows) {
    const { risks } = riskOf(p);
    const targeted = Object.prototype.hasOwnProperty.call(TARGETS, p.code);
    const flag = targeted ? 'FIX' : (risks.length ? 'review' : 'ok');
    console.log(`[${flag}] ${p.code}  ${p.type} ${p.value}  max_uses=${p.max_uses ?? '∞'} used=${p.uses_count || 0} expires=${p.expires_at || 'never'} active=${p.active}`);
    if (risks.length) console.log(`        risk: ${risks.join(', ')}`);
    if (targeted) console.log(`        reason: ${TARGETS[p.code]}`);
  }

  console.log('\n— Actions —');
  for (const code of Object.keys(TARGETS)) {
    const row = rows.find((r) => r.code === code);
    if (!row) { console.log(`  ${code}: not present (nothing to do)`); continue; }

    // Stripe side first (so a code is never live on Stripe after we disable the DB row).
    const stripeMsg = await deactivateStripe(stripe, code);

    if (code === 'PASS44TEST' && HARD_DELETE_TEST) {
      if (APPLY) { await db.from('promo_codes').delete().eq('code', code); }
      console.log(`  ${code}: ${APPLY ? 'DELETED row' : 'WOULD DELETE row'} | Stripe: ${stripeMsg}`);
      continue;
    }

    if (row.active === false) {
      console.log(`  ${code}: DB already inactive | Stripe: ${stripeMsg}`);
      continue;
    }
    if (APPLY) {
      const { error: upErr } = await db.from('promo_codes').update({ active: false }).eq('code', code);
      console.log(`  ${code}: ${upErr ? 'DB ERROR ' + upErr.message : 'DB active=false'} | Stripe: ${stripeMsg}`);
    } else {
      console.log(`  ${code}: WOULD set DB active=false | Stripe: ${stripeMsg}`);
    }
  }

  console.log(`\n${APPLY ? 'APPLIED.' : 'DRY RUN complete — re-run with --apply to write.'}`);
  console.log('Note: FRIEND10 is disabled, not repaired. To re-offer it safely, either make it a');
  console.log('percentage, or wait for the min-order guard in the pricing-module PR (PR A), then re-enable.');
  console.log('Codes flagged [review] (e.g. LAUNCH50 uncapped %) are left for you to decide.');
  process.exit(0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
