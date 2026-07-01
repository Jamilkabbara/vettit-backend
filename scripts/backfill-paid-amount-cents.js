#!/usr/bin/env node
/**
 * P0-6 backfill — stamp Stripe-confirmed paid_amount_cents on paid missions
 * that are missing it (the "paid_at set but paid_amount_cents null" rows the
 * admin Costs panel flags). The webhook + recovery-cron fixes stop NEW rows
 * from landing null; this fixes the historical ones.
 *
 *   node scripts/backfill-paid-amount-cents.js          # DRY RUN (no writes)
 *   node scripts/backfill-paid-amount-cents.js --apply  # write the amounts
 *
 * For each affected mission it resolves the real captured amount from Stripe:
 *   1) latest_payment_intent_id -> paymentIntents.retrieve -> amount_received
 *   2) else search Stripe PIs by metadata.missionId for a succeeded one
 * Writes paid_amount_cents (+ paid_amount_estimated=false) only for rows where
 * Stripe confirms a captured amount. Rows with no resolvable succeeded PI are
 * REPORTED for manual reconciliation, never guessed. Historical charges are
 * read-only here — we only fill the missing DB field.
 *
 * Env (.env): SUPABASE_URL, SUPABASE_SERVICE_KEY[,_ROLE_KEY], STRIPE_SECRET_KEY.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const APPLY = process.argv.includes('--apply');

async function resolveAmountCents(stripe, mission) {
  // 1) direct PI lookup
  if (mission.latest_payment_intent_id) {
    try {
      const pi = await stripe.paymentIntents.retrieve(mission.latest_payment_intent_id);
      if (pi && pi.status === 'succeeded' && Number.isFinite(pi.amount_received)) {
        return { cents: pi.amount_received, source: `pi:${pi.id}` };
      }
    } catch (e) { /* fall through to search */ }
  }
  // 2) search by metadata.missionId
  try {
    const res = await stripe.paymentIntents.search({
      query: `metadata['missionId']:'${mission.id}' AND status:'succeeded'`,
      limit: 10,
    });
    const withAmt = (res.data || []).filter((p) => Number.isFinite(p.amount_received) && p.amount_received > 0);
    if (withAmt.length) {
      // Prefer the most recent.
      withAmt.sort((a, b) => (b.created || 0) - (a.created || 0));
      return { cents: withAmt[0].amount_received, source: `search:${withAmt[0].id}` };
    }
  } catch (e) { /* search unavailable / errored */ }
  return null;
}

(async () => {
  const url = process.env.SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) throw new Error('Need SUPABASE_URL + SUPABASE_SERVICE_KEY in .env');
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('Need STRIPE_SECRET_KEY in .env (Stripe is the source of truth for the amount)');
  const db = createClient(url, service, { auth: { persistSession: false } });
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

  const { data: rows, error } = await db
    .from('missions')
    .select('id, title, paid_at, paid_amount_cents, total_price_usd, latest_payment_intent_id')
    .not('paid_at', 'is', null)
    .is('paid_amount_cents', null)
    .order('paid_at', { ascending: true });
  if (error) throw new Error(`query failed: ${error.message}`);

  console.log(`\nMODE: ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}`);
  console.log(`${rows.length} missions with paid_at but no paid_amount_cents\n`);

  let filled = 0, manual = 0;
  for (const m of rows) {
    const resolved = await resolveAmountCents(stripe, m);
    const est = m.total_price_usd != null ? `$${m.total_price_usd}` : '?';
    if (!resolved) {
      manual++;
      console.log(`  [MANUAL] ${m.id.slice(0, 8)}  no succeeded PI found in Stripe (est ${est}, pi=${m.latest_payment_intent_id || 'none'})`);
      continue;
    }
    const dollars = (resolved.cents / 100).toFixed(2);
    if (APPLY) {
      const { error: upErr } = await db.from('missions')
        .update({ paid_amount_cents: resolved.cents, paid_amount_estimated: false })
        .eq('id', m.id)
        .is('paid_amount_cents', null); // idempotent
      console.log(`  [${upErr ? 'ERROR' : 'SET'}] ${m.id.slice(0, 8)}  $${dollars}  (${resolved.source})${upErr ? ' ' + upErr.message : ''}`);
      if (!upErr) filled++;
    } else {
      console.log(`  [WOULD SET] ${m.id.slice(0, 8)}  $${dollars}  (${resolved.source})`);
      filled++;
    }
  }

  console.log(`\n${filled} resolvable from Stripe${APPLY ? ' (written)' : ' (dry run)'}, ${manual} need manual reconciliation.`);
  if (manual > 0) console.log('Manual rows: look them up in the Stripe Dashboard by metadata.missionId; if a charge succeeded, set paid_amount_cents by hand, else they were never actually captured.');
  process.exit(0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
