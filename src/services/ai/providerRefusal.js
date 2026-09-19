/**
 * The AI provider refused a call: say so, loudly, to an admin.
 *
 * On 2026-09-18 the provider account hit its spend cap and refused every call
 * for a day. Nothing raised an alert: survey generation, targeting and
 * clarify all failed into a customer's session, and the website quietly
 * built a template survey. The first anyone knew was reading the logs.
 *
 * classifyProviderError() names what happened, in the terms the owner needs
 * to fix it (spend cap, empty credit, bad key, rate limit, overloaded).
 * reportProviderRefusal() raises one admin_alerts row and one email per kind
 * per hour for the kinds that stop every mission until a person acts. Rate
 * limits and overloads are transient: logged, not paged.
 *
 * Never throws. An alert that cannot be written must not change what the
 * caller does with the original error.
 */
'use strict';

const logger = require('../../utils/logger');

const BLOCKING = new Set(['spend_cap', 'credit_balance', 'auth']);
const THROTTLE_MS = 60 * 60 * 1000;
const lastRaised = new Map();

const WHAT_TO_DO = {
  spend_cap: 'Raise or remove the usage limit in the AI provider console. Every AI call is refused until then.',
  credit_balance: 'Add credit to the AI provider account. Every AI call is refused until then.',
  auth: 'The AI provider API key is invalid or revoked. Set a valid key on the backend.',
  rate_limit: 'Transient. Calls will retry; alert only if it persists.',
  overloaded: 'Transient provider overload. Calls will retry.',
};

function classifyProviderError(error) {
  if (!error) return null;
  const status = Number(error.status) || null;
  const type = error.error?.error?.type || error.error?.type || null;
  const message = String(error.error?.error?.message || error.message || '');
  let kind = null;
  if (/usage limit/i.test(message)) kind = 'spend_cap';
  else if (/credit balance/i.test(message)) kind = 'credit_balance';
  else if (status === 401 || status === 403 || type === 'authentication_error' || type === 'permission_error') kind = 'auth';
  else if (status === 429 || type === 'rate_limit_error') kind = 'rate_limit';
  else if (status === 529 || type === 'overloaded_error') kind = 'overloaded';
  if (!kind) return null;
  return { kind, status, type, message: message.slice(0, 400), blocking: BLOCKING.has(kind), whatToDo: WHAT_TO_DO[kind] };
}

/**
 * @param {Error} error      the provider error
 * @param {object} context   { callType, model, missionId, userId }
 * @param {object} [deps]    injected for tests: { supabase, email, now }
 * @returns {Promise<{raised: boolean, reason?: string, refusal?: object}>}
 */
async function reportProviderRefusal(error, context = {}, deps = {}) {
  try {
    const refusal = classifyProviderError(error);
    if (!refusal) return { raised: false, reason: 'not_a_provider_refusal' };
    logger.error('AI provider refused the call', { ...context, ...refusal });
    if (!refusal.blocking) return { raised: false, reason: 'transient', refusal };

    const now = deps.now ? deps.now() : Date.now();
    const last = lastRaised.get(refusal.kind) || 0;
    if (now - last < THROTTLE_MS) return { raised: false, reason: 'throttled', refusal };
    lastRaised.set(refusal.kind, now);

    const supabase = deps.supabase || require('../../db/supabase');
    const since = new Date(now - THROTTLE_MS).toISOString();
    const { data: open } = await supabase
      .from('admin_alerts').select('id')
      .eq('alert_type', 'ai_provider_refused').eq('resolved', false)
      .gte('created_at', since).limit(1);
    if (Array.isArray(open) && open.length) return { raised: false, reason: 'already_open', refusal };

    const payload = {
      kind: refusal.kind,
      http_status: refusal.status,
      error_type: refusal.type,
      provider_message: refusal.message,
      action_required: refusal.whatToDo,
      first_call_type: context.callType || null,
      model: context.model || null,
    };
    const { data: rows, error: insErr } = await supabase
      .from('admin_alerts')
      .insert({ alert_type: 'ai_provider_refused', mission_id: context.missionId || null, user_id: context.userId || null, payload, resolved: false })
      .select('id, alert_type, mission_id, payload, created_at');
    if (insErr) logger.warn('ai_provider_refused alert insert failed', { err: insErr.message });

    // Page now, not in tomorrow's digest: nothing works until someone acts.
    const email = deps.email || require('../email');
    const alert = (rows && rows[0]) || { id: 'unsaved', alert_type: 'ai_provider_refused', mission_id: null, payload, created_at: new Date(now).toISOString() };
    await email.sendAdminAlertDigest({
      to: process.env.ADMIN_ALERT_EMAIL || 'kabbarajamil@gmail.com',
      alerts: [alert],
      windowHours: 1,
    }).catch((e) => logger.warn('ai_provider_refused email failed', { err: e.message }));

    return { raised: true, refusal };
  } catch (err) {
    logger.warn('reportProviderRefusal failed (non-fatal)', { err: err.message });
    return { raised: false, reason: 'error' };
  }
}

function _resetThrottleForTests() { lastRaised.clear(); }

module.exports = { classifyProviderError, reportProviderRefusal, _resetThrottleForTests };
