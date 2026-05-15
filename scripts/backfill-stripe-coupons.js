#!/usr/bin/env node
/*
 * Pass 42 F3 — one-time backfill: create Stripe coupons + promotion
 * codes for existing promo_codes rows that don't have them yet.
 *
 * Skips:
 *   - Rows with sync_to_stripe = false (internal-only)
 *   - Rows that already have stripe_coupon_id (idempotent)
 *   - VETT100 by default (treated as internal even though
 *     sync_to_stripe might be true on legacy rows; pass --include-vett100
 *     to override)
 *
 * Usage:
 *   node scripts/backfill-stripe-coupons.js [--dry-run] [--include-vett100]
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { createPromoOnStripe } = require('../src/services/stripe');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_KEY   = process.env.STRIPE_SECRET_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
  process.exit(1);
}
if (!STRIPE_KEY) {
  console.error('Missing STRIPE_SECRET_KEY env var');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const includeVett100 = args.includes('--include-vett100');

async function main() {
  console.log(`[backfill-stripe-coupons] starting (dryRun=${dryRun}, includeVett100=${includeVett100})`);

  const { data: rows, error } = await supabase
    .from('promo_codes')
    .select('code, type, value, description, active, max_uses, expires_at, sync_to_stripe, stripe_coupon_id');
  if (error) {
    console.error('fetch promo_codes failed', error.message);
    process.exit(1);
  }

  const candidates = rows.filter((r) => {
    if (r.stripe_coupon_id) return false; // already synced
    if (r.sync_to_stripe === false) return false; // explicitly opted out
    if (!includeVett100 && r.code === 'VETT100') return false; // internal
    return true;
  });

  console.log(`[backfill-stripe-coupons] ${rows.length} promo_codes total; ${candidates.length} need sync`);

  let succeeded = 0;
  for (const row of candidates) {
    if (dryRun) {
      console.log(`[${row.code}] DRY: would sync type=${row.type} value=${row.value}`);
      succeeded += 1;
      continue;
    }
    try {
      const { coupon_id, promotion_code_id } = await createPromoOnStripe({
        code: row.code,
        type: row.type,
        value: row.value,
        description: row.description,
        max_uses: row.max_uses,
        expires_at: row.expires_at,
        active: row.active,
      });
      const { error: updErr } = await supabase
        .from('promo_codes')
        .update({
          stripe_coupon_id: coupon_id,
          stripe_promotion_code_id: promotion_code_id,
        })
        .eq('code', row.code);
      if (updErr) {
        console.error(`[${row.code}] update failed`, updErr.message);
        continue;
      }
      console.log(`[${row.code}] synced — coupon=${coupon_id} promo=${promotion_code_id}`);
      succeeded += 1;
    } catch (err) {
      console.error(`[${row.code}] stripe sync failed`, err.message);
    }
  }

  console.log(`[backfill-stripe-coupons] complete: ${succeeded}/${candidates.length} synced`);
}

main().catch((err) => {
  console.error('backfill-stripe-coupons crashed', err);
  process.exit(1);
});
