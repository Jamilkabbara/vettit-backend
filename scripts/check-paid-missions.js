/**
 * Every mission marked paid must be explained: a matching Stripe charge, a
 * promo code, an admin override with a reason, or a reviewed exception.
 * Read-only. Exits 1 if any mission is unexplained.
 *
 *   railway run node scripts/check-paid-missions.js
 */
'use strict';
const supabase = require('../src/db/supabase');
const { stripeClient } = require('../src/services/stripe');
const { auditPaidMissions } = require('../src/services/payments/paidMissionAudit');

(async () => {
  const results = await auditPaidMissions({ supabase, stripe: stripeClient });
  const counts = {};
  for (const r of results) {
    counts[r.explanation] = (counts[r.explanation] || 0) + 1;
    console.log(`${r.ok ? 'ok     ' : 'PROBLEM'} ${r.missionId.slice(0, 8)} ${r.explanation.padEnd(18)} ${r.problem ? `${r.problem}: ${r.detail}` : ''}`);
  }
  const problems = results.filter((r) => !r.ok);
  console.log(`\n${results.length} paid missions: ${JSON.stringify(counts)}; ${problems.length} unexplained`);
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error('FAILED', e.message); process.exit(2); });
