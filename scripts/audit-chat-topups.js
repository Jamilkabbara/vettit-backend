#!/usr/bin/env node
/**
 * Read-only: every chat top-up charge in Stripe, against what the database
 * knows about it.
 *
 * A chat top-up buys +50 chat messages for $5. The webhook credits the
 * messages to the chat session and records the PaymentIntent id in that
 * session's metadata, so the credit is idempotent. It records the MONEY
 * nowhere: revenue, invoices and the admin dashboard are all computed from
 * `missions`, and a top-up has no mission. The charge exists only in Stripe.
 *
 * This script answers three questions and changes nothing:
 *   1. How many top-up charges exist in Stripe, and for how much?
 *   2. Which of them credited their messages (the customer got what they paid
 *      for), and which did not?
 *   3. Which are recorded as revenue anywhere in the database?
 *
 * Refunds count: a refunded top-up is still a charge, and net is what matters.
 *
 *   railway run node scripts/audit-chat-topups.js
 */
'use strict';

const Stripe = require('stripe');
const supabase = require('../src/db/supabase');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const usd = (c) => `$${(Number(c || 0) / 100).toFixed(2)}`;

async function allChatTopupPayments() {
  // Search covers metadata; paginate rather than trusting one page.
  const out = [];
  let page;
  for (;;) {
    const res = await stripe.paymentIntents.search({
      query: "metadata['purpose']:'chat_overage'",
      limit: 100,
      ...(page ? { page } : {}),
    });
    out.push(...res.data);
    if (!res.has_more) break;
    page = res.next_page;
  }
  return out;
}

(async () => {
  const pis = await allChatTopupPayments();
  const succeeded = pis.filter((p) => p.status === 'succeeded');

  // What the database knows: the chat session that was credited.
  const { data: sessions, error } = await supabase
    .from('chat_sessions')
    .select('id, user_id, metadata, quota_overage_purchased, created_at');
  if (error) throw error;
  const creditedPis = new Set();
  for (const s of sessions || []) {
    for (const pi of (s.metadata && s.metadata.granted_payment_intents) || []) creditedPis.add(pi);
  }

  // Is the money recorded anywhere? The only revenue surface is missions.
  const { data: missionsWithPi } = await supabase
    .from('missions')
    .select('id, latest_payment_intent_id, stripe_refund_ids')
    .not('latest_payment_intent_id', 'is', null);
  const missionPis = new Set((missionsWithPi || []).map((m) => m.latest_payment_intent_id));

  const rows = [];
  let grossCents = 0;
  let refundedCents = 0;
  for (const pi of succeeded) {
    const refunded = Number(pi.amount_received || 0) > 0
      ? (pi.charges && pi.charges.data && pi.charges.data[0] ? Number(pi.charges.data[0].amount_refunded || 0) : 0)
      : 0;
    grossCents += Number(pi.amount_received || 0);
    refundedCents += refunded;
    rows.push({
      id: pi.id,
      created: new Date(pi.created * 1000).toISOString().slice(0, 10),
      amount_cents: Number(pi.amount_received || 0),
      refunded_cents: refunded,
      chat_session_id: (pi.metadata && pi.metadata.sessionId) || null,
      messages_credited: creditedPis.has(pi.id),
      recorded_as_revenue: missionPis.has(pi.id),
      customer_email: (pi.receipt_email || (pi.metadata && pi.metadata.email)) || null,
    });
  }

  const notCredited = rows.filter((r) => !r.messages_credited);
  const notRecorded = rows.filter((r) => !r.recorded_as_revenue);

  console.log(JSON.stringify({
    stripe_payment_intents_found: pis.length,
    succeeded: succeeded.length,
    gross: usd(grossCents),
    refunded: usd(refundedCents),
    net: usd(grossCents - refundedCents),
    messages_not_credited: notCredited.length,
    not_recorded_as_revenue: notRecorded.length,
    not_recorded_total_net: usd(notRecorded.reduce((a, r) => a + r.amount_cents - r.refunded_cents, 0)),
  }, null, 2));
  console.log('\nEvery top-up charge:');
  for (const r of rows.sort((a, b) => a.created.localeCompare(b.created))) console.log(JSON.stringify(r));
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
