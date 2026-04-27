/**
 * Pass 22 Bug 22.1 — Funnel event ingestion endpoint.
 *
 * Replaces the old client-side direct-insert into funnel_events. Reasons:
 *
 *   * Anon emits land. The existing user_insert_own_funnel RLS policy is
 *     authenticated-only, so anon visitors' landing_view emits were
 *     silently rejected by default-deny. (27 landing_view rows in 14d came
 *     exclusively from previously-authenticated users hitting the page.)
 *
 *   * fetch keepalive: true survives navigation. The old supabase-js path
 *     queued an async insert that the browser would cancel when the user
 *     navigated away mid-emit — root cause of the ~24% emit reliability
 *     for mission_setup_started.
 *
 *   * Server-side enrichment. We can stamp UA, derived viewport from header
 *     hints, IP-based geo (if/when we add it) without trusting the client.
 *
 * The endpoint accepts both anon and authenticated callers:
 *   - If Authorization: Bearer <jwt> is present and resolvable, user_id is
 *     set from the verified JWT (cannot be spoofed in the body).
 *   - Otherwise user_id is NULL (anon emit) and session_id correlates the
 *     event with later authenticated events from the same browser.
 *
 * Rate limit: mounted with a dedicated higher-limit middleware in app.js
 * (200/15min per IP) since legitimate sessions emit 5-10 events.
 *
 * Body shape:
 *   {
 *     event_type: string (required, validated against allowlist below),
 *     session_id: string (required, ≤64 chars),
 *     mission_id: uuid (optional),
 *     metadata: object (optional, ≤4KB after stringify)
 *   }
 */

const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const logger = require('../utils/logger');

const ALLOWED_EVENT_TYPES = new Set([
  'landing_view',
  'signup_started',
  'signup_completed',
  'mission_setup_started',
  'mission_setup_completed',
  'checkout_opened',
  'checkout_completed',
  'mission_paid',
  'mission_completed',
]);

/**
 * Best-effort JWT → user_id resolution. Never throws — anon emits are valid.
 * Reuses the supabase service-role client (which can verify JWTs via auth.getUser).
 */
async function resolveUserIdFromAuth(req) {
  const auth = req.headers?.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length).trim();
  if (!token) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user?.id) return null;
    return data.user.id;
  } catch (_) {
    return null;
  }
}

/**
 * POST /api/funnel/track
 *   Anon-friendly. Validates body, resolves user_id (best-effort), inserts
 *   via service_role. Always returns 202 — never block the user-visible
 *   experience on telemetry, even if the row failed to insert.
 */
router.post('/track', async (req, res) => {
  const b = req.body || {};

  // Validation — silent reject (still 202) so we don't leak schema to
  // probing requests, but log for observability.
  if (!b.event_type || !ALLOWED_EVENT_TYPES.has(b.event_type)) {
    logger.debug('funnel.track: rejected unknown event_type', { event_type: b.event_type });
    return res.status(202).json({ accepted: false, reason: 'unknown_event_type' });
  }
  if (!b.session_id || typeof b.session_id !== 'string' || b.session_id.length > 64) {
    logger.debug('funnel.track: rejected invalid session_id');
    return res.status(202).json({ accepted: false, reason: 'invalid_session_id' });
  }

  // Cap metadata size — prevents accidental shipping of giant payloads.
  let metadata = b.metadata && typeof b.metadata === 'object' ? b.metadata : {};
  try {
    if (JSON.stringify(metadata).length > 4096) {
      metadata = { _truncated: true, _original_size: JSON.stringify(b.metadata).length };
    }
  } catch {
    metadata = {};
  }

  // Server-side enrichment — UA + referer don't depend on client honesty.
  metadata = {
    ...metadata,
    _ua:      req.headers?.['user-agent']     || null,
    _referer: req.headers?.referer            || null,
  };

  const user_id = await resolveUserIdFromAuth(req);

  const row = {
    user_id,
    session_id: b.session_id,
    event_type: b.event_type,
    mission_id: b.mission_id || null,
    metadata,
  };

  // Fire-and-respond — telemetry must never block the UX. We still await the
  // insert to surface DB errors in our logs, but errors don't change the
  // 202 response shape.
  const { error } = await supabase.from('funnel_events').insert(row);
  if (error) {
    logger.warn('funnel.track: insert failed (non-fatal)', {
      event_type: b.event_type, err: error.message,
    });
    return res.status(202).json({ accepted: false, reason: 'insert_failed' });
  }

  res.status(202).json({ accepted: true });
});

module.exports = router;
