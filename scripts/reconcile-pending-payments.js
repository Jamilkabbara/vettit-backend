#!/usr/bin/env node
/*
 * Reconcile missions stuck in `pending_payment` whose Stripe Checkout Session
 * actually paid — the safety net for a webhook outage (e.g. a stale
 * STRIPE_WEBHOOK_SECRET dropping live signature verification).
 *
 * Idempotent + no-clobber: reuses confirmCheckoutSessionPaid, which marks paid
 * + triggers runMission ONLY when the Stripe session is genuinely paid and the
 * mission hasn't already been processed. Never charges, never downgrades.
 *
 * Run on Railway (needs the live STRIPE_SECRET_KEY + Supabase + Anthropic keys):
 *   node scripts/reconcile-pending-payments.js --dry-run   # list, no writes
 *   node scripts/reconcile-pending-payments.js             # reconcile
 */
require('dotenv').config();
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = require('../src/db/supabase');
const { confirmCheckoutSessionPaid } = require('../src/services/payments/confirmCheckoutSession');
const { runMission } = require('../src/jobs/runMission');

const dryRun = process.argv.slice(2).includes('--dry-run');

(async () => {
  const { data: stuck, error } = await supabase
    .from('missions')
    .select('id, goal_type, total_price_usd, checkout_session_id, created_at')
    .eq('status', 'pending_payment')
    .not('checkout_session_id', 'is', null)
    .order('created_at', { ascending: true });
  if (error) { console.error('query failed:', error.message); process.exit(1); }

  console.log(`pending_payment missions with a checkout session: ${stuck.length}${dryRun ? '  (DRY RUN — no writes)' : ''}`);
  let reconciled = 0;
  for (const m of stuck) {
    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(m.checkout_session_id);
    } catch (e) {
      console.log(`  ${m.id.slice(0, 8)} — Stripe retrieve failed: ${e.message}`);
      continue;
    }
    const paid = session.payment_status === 'paid' || session.status === 'complete';
    console.log(`  ${m.id.slice(0, 8)} | ${m.goal_type} | $${m.total_price_usd} | stripe=${session.payment_status}/${session.status}${paid ? ' → PAID' : ' → not paid (leave)'}`);
    if (!paid || dryRun) continue;
    try {
      const r = await confirmCheckoutSessionPaid({ supabase, runMission }, session);
      if (r.triggered) reconciled += 1;
      console.log(`        ${r.triggered ? 'reconciled + runMission triggered' : 'no-op: ' + (r.reason || 'already processed')}`);
    } catch (e) {
      console.log(`        confirm failed: ${e.message}`);
    }
  }
  console.log(`\n${dryRun ? 'DRY: ' : ''}reconciled ${reconciled} mission(s).`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
