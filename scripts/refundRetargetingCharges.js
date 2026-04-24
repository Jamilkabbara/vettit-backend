#!/usr/bin/env node
/**
 * scripts/refundRetargetingCharges.js
 *
 * Identifies missions where users paid the retargeting pixel surcharge ($1.50/respondent)
 * and issues partial Stripe refunds for that amount.
 *
 * The retargeting pixel feature was removed on 2026-04-24 because the backend
 * never actually fired any pixels — AI personas have no browsers or ad-platform
 * cookies. Users who opted in were charged for a feature that didn't work.
 *
 * Usage:
 *   DRY RUN (safe — prints the list, does nothing):
 *     node scripts/refundRetargetingCharges.js
 *
 *   EXECUTE REFUNDS (requires explicit opt-in):
 *     EXECUTE=1 node scripts/refundRetargetingCharges.js
 *
 *   SEND EMAIL NOTIFICATIONS (only after EXECUTE=1 refunds succeed):
 *     EXECUTE=1 NOTIFY=1 node scripts/refundRetargetingCharges.js
 *
 * Environment variables required (from .env or Railway):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, STRIPE_SECRET_KEY,
 *   RESEND_API_KEY (only if NOTIFY=1), FROM_EMAIL, FROM_NAME, FRONTEND_URL
 */

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');
const { sendRetargetingRefundEmail } = require('../src/services/email');

// ── Guards ────────────────────────────────────────────────────────────────────

const EXECUTE = process.env.EXECUTE === '1';
const NOTIFY  = process.env.NOTIFY === '1';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.');
  process.exit(1);
}
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('❌ STRIPE_SECRET_KEY must be set.');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  VETT — Retargeting Surcharge Refund Script');
  console.log(`  Mode: ${EXECUTE ? '🔴 EXECUTE' : '🟡 DRY RUN'} ${NOTIFY ? '+ EMAIL NOTIFY' : ''}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  // ── 1. Find affected missions ────────────────────────────────────────────

  const { data: missions, error } = await supabase
    .from('missions')
    .select('id, user_id, respondent_count, stripe_payment_intent_id, paid_at, targeting, total_price_usd, status')
    .in('status', ['paid', 'completed', 'active'])
    .not('targeting', 'is', null);

  if (error) {
    console.error('❌ Supabase query failed:', error.message);
    process.exit(1);
  }

  // Filter to missions that actually had a pixel ID set
  const affected = (missions || []).filter((m) => {
    const retargeting = m.targeting?.retargeting;
    return (
      retargeting &&
      typeof retargeting.pixelPlatform === 'string' &&
      retargeting.pixelPlatform.trim() !== '' &&
      typeof retargeting.pixelId === 'string' &&
      retargeting.pixelId.trim() !== ''
    );
  });

  if (affected.length === 0) {
    console.log('✅ No affected missions found. Nothing to refund.');
    return;
  }

  console.log(`Found ${affected.length} mission(s) with retargeting surcharge:\n`);

  let totalRefundUsd = 0;

  for (const m of affected) {
    const surchargeCents = Math.round((m.respondent_count || 0) * 150); // $1.50 × n
    const surchargeUsd   = surchargeCents / 100;
    totalRefundUsd += surchargeUsd;

    console.log(
      `  Mission ${m.id.slice(0, 8).toUpperCase()} | ` +
      `PI: ${m.stripe_payment_intent_id || 'MISSING'} | ` +
      `${m.respondent_count} respondents | ` +
      `Refund: $${surchargeUsd.toFixed(2)} | ` +
      `Platform: ${m.targeting?.retargeting?.pixelPlatform || '?'} | ` +
      `Paid: ${m.paid_at ? new Date(m.paid_at).toLocaleDateString() : '?'}`
    );
  }

  console.log('');
  console.log(`TOTAL TO REFUND: $${totalRefundUsd.toFixed(2)} across ${affected.length} mission(s)`);
  console.log('');

  if (!EXECUTE) {
    console.log('──────────────────────────────────────────────────────────');
    console.log('This was a DRY RUN. No charges were refunded.');
    console.log('To execute, re-run with: EXECUTE=1 node scripts/refundRetargetingCharges.js');
    console.log('──────────────────────────────────────────────────────────');
    return;
  }

  // ── 2. Execute refunds ───────────────────────────────────────────────────

  console.log('🔴 EXECUTING REFUNDS…\n');

  // Group by user_id so we can send one email per user (not per mission)
  const byUser = {};

  for (const m of affected) {
    const surchargeCents = Math.round((m.respondent_count || 0) * 150);
    if (!m.stripe_payment_intent_id || surchargeCents === 0) {
      console.warn(`  ⚠  ${m.id.slice(0,8)}: skipped — no Stripe PI or zero amount`);
      continue;
    }

    try {
      const refund = await stripe.refunds.create({
        payment_intent: m.stripe_payment_intent_id,
        amount: surchargeCents,
        reason: 'requested_by_customer',
        metadata: {
          reason_internal: 'retargeting_feature_removed',
          mission_id: m.id,
          script_version: '1.0.0',
          run_date: new Date().toISOString(),
        },
      });

      console.log(
        `  ✓ Refunded ${m.id.slice(0,8)}: ` +
        `$${(surchargeCents / 100).toFixed(2)} → refund_id=${refund.id}`
      );

      // Accumulate per-user for email notification
      if (NOTIFY) {
        if (!byUser[m.user_id]) {
          byUser[m.user_id] = { totalUsd: 0, missionCount: 0 };
        }
        byUser[m.user_id].totalUsd += surchargeCents / 100;
        byUser[m.user_id].missionCount += 1;
      }
    } catch (err) {
      console.error(`  ✗ Failed ${m.id.slice(0,8)}: ${err.message}`);
    }
  }

  // ── 3. Send email notifications ──────────────────────────────────────────

  if (!NOTIFY || Object.keys(byUser).length === 0) {
    console.log('\n✅ Refunds complete. Set NOTIFY=1 to also send user emails.');
    return;
  }

  console.log('\n📧 Sending email notifications…\n');

  for (const [userId, { totalUsd, missionCount }] of Object.entries(byUser)) {
    try {
      // Fetch user profile for email + name
      const { data: profile } = await supabase
        .from('profiles')
        .select('email, first_name, full_name')
        .eq('id', userId)
        .single();

      // Fallback to auth.users if profile missing
      let email = profile?.email;
      let name  = profile?.full_name || profile?.first_name;

      if (!email) {
        const { data: authUser } = await supabase.auth.admin.getUserById(userId);
        email = authUser?.user?.email;
        name  = name || authUser?.user?.user_metadata?.full_name;
      }

      if (!email) {
        console.warn(`  ⚠  User ${userId.slice(0,8)}: no email found, skipping notification`);
        continue;
      }

      await sendRetargetingRefundEmail({
        to: email,
        name: name || undefined,
        refundAmountUsd: totalUsd,
        missionCount,
      });

      console.log(`  ✓ Notified ${email} (user ${userId.slice(0,8)}): $${totalUsd.toFixed(2)}`);
    } catch (err) {
      console.error(`  ✗ Email failed for user ${userId.slice(0,8)}: ${err.message}`);
    }
  }

  console.log('\n✅ All done.');
})();
