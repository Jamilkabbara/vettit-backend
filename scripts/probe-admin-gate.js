#!/usr/bin/env node
/**
 * P0-2 — live proof that /api/admin/* is blocked SERVER-SIDE for a non-admin.
 *
 *   node scripts/probe-admin-gate.js <existing-non-admin-email> [--with-admin]
 *
 * Mints a real Supabase JWT (via the service key, same pattern as
 * probe-coming-soon-gate.js) for the given EXISTING, NON-admin user, then hits
 * the admin endpoints. Expected results:
 *   - no JWT         -> 401 Unauthorized   (authenticate middleware)
 *   - non-admin JWT  -> 403 Forbidden       (adminOnly email allowlist)
 *   - admin JWT      -> 200 OK              (positive control; pass --with-admin)
 *
 * The email MUST already exist as a Supabase auth user (generateLink resolves an
 * existing user). Pass one of your real non-admin test accounts.
 *
 * Env (.env): SUPABASE_URL, SUPABASE_SERVICE_KEY[,_ROLE_KEY]. ADMIN_EMAIL
 * defaults to the owner. API defaults to prod; override with PROBE_API.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const API = process.env.PROBE_API || 'https://vettit-backend-production.up.railway.app';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'kabbarajamil@gmail.com';
// Every admin route family: routes/admin.js (overview/users/ai-costs) +
// routes/adminCosts.js (costs/*). All gated by authenticate + adminOnly.
const ADMIN_ROUTES = [
  '/api/admin/overview',
  '/api/admin/users',
  '/api/admin/ai-costs',
  '/api/admin/costs/dashboard',
];

async function mintJwt(email) {
  const url = process.env.SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) throw new Error('Need SUPABASE_URL + SUPABASE_SERVICE_KEY in .env');
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw new Error(`generateLink(${email}) failed: ${error.message} (is this an existing user?)`);
  const tokenHash = data && data.properties && data.properties.hashed_token;
  if (!tokenHash) throw new Error('generateLink returned no hashed_token');
  const pub = createClient(url, service, { auth: { persistSession: false } });
  const { data: sess, error: e2 } = await pub.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
  if (e2) throw new Error(`verifyOtp failed: ${e2.message}`);
  if (!sess || !sess.session || !sess.session.access_token) throw new Error('verifyOtp returned no access_token');
  return sess.session.access_token;
}

async function status(route, jwt) {
  const res = await fetch(`${API}${route}`, { headers: jwt ? { Authorization: `Bearer ${jwt}` } : {} });
  return res.status;
}

(async () => {
  const args = process.argv.slice(2);
  const nonAdminEmail = args.find((a) => a.includes('@'));
  const withAdmin = args.includes('--with-admin');
  if (!nonAdminEmail) {
    console.error('Usage: node scripts/probe-admin-gate.js <existing-non-admin-email> [--with-admin]');
    process.exit(2);
  }
  if (nonAdminEmail.toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
    console.error(`${nonAdminEmail} IS the admin email. Pass a NON-admin user to prove the gate.`);
    process.exit(2);
  }

  let failures = 0;
  console.log(`API: ${API}\nAdmin email (allowlisted): ${ADMIN_EMAIL}\n`);

  // 1) Unauthenticated -> 401 on every admin route.
  console.log('No JWT (expect 401):');
  for (const r of ADMIN_ROUTES) {
    const s = await status(r, null);
    const ok = s === 401;
    if (!ok) failures++;
    console.log(`  ${r}  ->  ${s}  ${ok ? '✓' : '✗ expected 401'}`);
  }

  // 2) Authenticated NON-admin -> 403 on every admin route.
  console.log(`\nNon-admin JWT for ${nonAdminEmail} (expect 403):`);
  const naJwt = await mintJwt(nonAdminEmail);
  for (const r of ADMIN_ROUTES) {
    const s = await status(r, naJwt);
    const ok = s === 403;
    if (!ok) failures++;
    console.log(`  ${r}  ->  ${s}  ${ok ? '✓' : '✗ expected 403'}`);
  }

  // 3) Positive control: admin JWT -> 200 (opt-in).
  if (withAdmin) {
    console.log(`\nAdmin JWT for ${ADMIN_EMAIL} (expect 200, positive control):`);
    const aJwt = await mintJwt(ADMIN_EMAIL);
    for (const r of ADMIN_ROUTES) {
      const s = await status(r, aJwt);
      console.log(`  ${r}  ->  ${s}  ${s === 200 ? '✓' : `(got ${s})`}`);
    }
  }

  console.log(`\n${failures === 0
    ? 'PASS — /api/admin/* is gated server-side: 401 without a token, 403 for a non-admin. P0-2 proven.'
    : `FAIL — ${failures} route(s) did not return the expected status. The admin gate is NOT solid.`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
