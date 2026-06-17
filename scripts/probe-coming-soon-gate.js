#!/usr/bin/env node
/**
 * §A0 — independent live probe of the server-side Coming-Soon gate.
 *
 * Mints a FRESH JWT for the owner (via the Supabase service key — admin
 * magiclink → verifyOtp, no password, nothing emailed) and pushes a
 * mission-create against the LIVE API for each gated type. The gate fires
 * BEFORE any DB insert, so a 403 `not_available` means the server refused it
 * with ZERO side effects (no mission created, no charge). A live type
 * (validate) is probed too and must NOT be gated.
 *
 * Run after the gate is deployed:
 *     cd ~/vettit-backend && node scripts/probe-coming-soon-gate.js
 *
 * Env (from .env): SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY.
 * Override the target with PROBE_API_URL; supply your own token with PROBE_JWT
 * (e.g. copied from the live app's session) to skip minting; PROBE_EMAIL to
 * mint for a different account (default: the owner).
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const API = process.env.PROBE_API_URL || 'https://vettit-backend-production.up.railway.app';
const EMAIL = process.env.PROBE_EMAIL || 'kabbarajamil@gmail.com';
const GATED = ['market_entry', 'audience_profiling', 'creative_attention'];
const LIVE = 'validate';

async function mintJwt() {
  if (process.env.PROBE_JWT) return process.env.PROBE_JWT;
  const url = process.env.SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !service || !anon) {
    throw new Error('Need SUPABASE_URL + SUPABASE_SERVICE_KEY + SUPABASE_ANON_KEY in .env (or pass PROBE_JWT).');
  }
  const admin = createClient(url, service, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: EMAIL });
  if (error) throw new Error(`generateLink failed: ${error.message}`);
  const tokenHash = data?.properties?.hashed_token;
  if (!tokenHash) throw new Error('generateLink returned no hashed_token');
  const pub = createClient(url, anon, { auth: { persistSession: false } });
  const { data: sess, error: e2 } = await pub.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
  if (e2) throw new Error(`verifyOtp failed: ${e2.message}`);
  if (!sess?.session?.access_token) throw new Error('verifyOtp returned no access_token');
  return sess.session.access_token;
}

async function createProbe(jwt, goalType) {
  const res = await fetch(`${API}/api/missions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ goalType, brief: 'coming-soon gate probe', respondentCount: 300 }),
  });
  let body = {};
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, error: body.error, message: body.message, id: body.id };
}

(async () => {
  console.log(`Probing ${API} as ${EMAIL}\n`);
  const jwt = await mintJwt();
  console.log('Minted a fresh JWT.\n');

  let allGood = true;
  for (const g of GATED) {
    const r = await createProbe(jwt, g);
    const ok = r.status === 403 && r.error === 'not_available';
    allGood = allGood && ok;
    console.log(`  CREATE ${g.padEnd(20)} → HTTP ${r.status} ${r.error || ''}  ${ok ? '✅ refused (zero charge)' : '❌ EXPECTED 403 not_available'}`);
  }
  const live = await createProbe(jwt, LIVE);
  const liveOk = live.status !== 403;
  allGood = allGood && liveOk;
  console.log(`  CREATE ${LIVE.padEnd(20)} → HTTP ${live.status} ${live.error || '(created)'}  ${liveOk ? '✅ not gated (live unaffected)' : '❌ live type wrongly gated'}`);
  if (live.id) console.log(`     (note: created a throwaway draft mission ${live.id} — no charge; delete if you like)`);

  console.log(`\n${allGood ? '✅ GATE LIVE: server refuses Coming-Soon types and allows live types.' : '❌ Gate not behaving as expected — is it deployed?'}`);
  process.exit(allGood ? 0 : 1);
})().catch((e) => { console.error('Probe failed:', e.message); process.exit(2); });
