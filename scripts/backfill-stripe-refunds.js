#!/usr/bin/env node
/**
 * Backfill Stripe refunds onto missions.
 *
 *   node scripts/backfill-stripe-refunds.js           # DRY RUN: prints the plan, writes nothing
 *   EXECUTE=1 node scripts/backfill-stripe-refunds.js  # writes the same plan
 *
 * Run under `railway run` so the production keys are injected and never typed.
 *
 * SELECTION (shared by both runs): every mission with a paid_at. For each,
 * Stripe is read fresh (the stored PaymentIntent and any succeeded
 * PaymentIntent whose metadata.missionId names the mission), and
 * planRefundSync - the same function the refund webhook uses - decides the
 * row. Dry run and real run call selectMissions() and planRefundSync() the
 * same way; EXECUTE only changes whether the patch is written.
 *
 * Nothing about what the customer bought is rewritten: paid_amount_cents,
 * total_price_usd and the cost lines are untouched. Only the three refund
 * columns are set, to Stripe's values.
 */
'use strict';
const supabase = require('../src/db/supabase');
const { stripeClient } = require('../src/services/stripe');
const { updateMission } = require('../src/db/missionSchema');
const { readMissionStripeState, planRefundSync, MISSION_COLUMNS } = require('../src/services/payments/syncMissionRefunds');

const EXECUTE = process.env.EXECUTE === '1';

async function selectMissions() {
  const { data, error } = await supabase.from('missions').select(MISSION_COLUMNS)
    .not('paid_at', 'is', null).order('paid_at', { ascending: true });
  if (error) throw error;
  return data;
}

(async () => {
  const missions = await selectMissions();
  const plans = [];
  for (const m of missions) {
    const state = await readMissionStripeState(stripeClient, m);
    if (state.paymentIntentIds.length) plans.push(planRefundSync(m, state));
  }

  const $ = (c) => (c == null ? '-' : `$${(c / 100).toFixed(2)}`);
  console.log(`${EXECUTE ? 'EXECUTE' : 'DRY RUN'}: ${missions.length} paid missions, ${plans.length} with a Stripe charge\n`);
  console.log('mission   charge                          captured  refunded  net      recorded-now  legacy-partial  action');
  for (const p of plans) {
    console.log(`${p.missionId.slice(0, 8)}  ${String(p.chargeIds.join('+')).padEnd(30)}  ${$(p.capturedCents).padStart(8)}  ${$(p.refundedCents).padStart(8)}  ${$(p.netCents).padStart(7)}  ${$(p.recordedCents).padStart(12)}  ${(p.legacyPartialRefundCents == null ? '-' : $(p.legacyPartialRefundCents)).padStart(14)}  ${p.changed ? 'SET' : 'no change'}`);
  }
  const sum = (k) => plans.reduce((s, p) => s + p[k], 0);
  console.log(`\ncaptured ${$(sum('capturedCents'))}, refunded ${$(sum('refundedCents'))}, net kept ${$(sum('netCents'))}; ${plans.filter((p) => p.changed).length} rows to set`);

  if (!EXECUTE) { console.log('\nDry run only. Re-run with EXECUTE=1 to write.'); process.exit(0); }
  let written = 0;
  for (const p of plans.filter((x) => x.changed)) {
    const { error } = await updateMission(supabase, p.missionId, p.patch, { caller: 'backfill-stripe-refunds', strict: true });
    if (error) { console.error('write failed', p.missionId.slice(0, 8), error.message); process.exit(1); }
    written++;
  }
  console.log(`\nwrote ${written} rows`);
  process.exit(0);
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
