/**
 * VETT — Chat service with per-scope quota enforcement.
 *
 * Scopes:
 *   - 'results'   (Results-page copilot)   → 30 messages per mission
 *   - 'dashboard' (Dashboard copilot)      → 30 messages per calendar month
 *   - 'setup'    (Setup advisor)           → 20 messages per setup session
 *
 * Overage: when a user hits their quota they can buy +50 messages for $5.
 * That surcharge grants `quota_overage_purchased += 50` on the session row.
 *
 * Context provided to the model per scope:
 *   - results   → mission metadata + insights + aggregated responses
 *   - dashboard → the user's recent missions (titles, statuses, headline stats)
 *   - setup    → the draft mission being edited (brief, questions, targeting)
 */

const supabase = require('../../db/supabase');
const { callClaude, streamClaude, MODEL_ROUTING } = require('./anthropic');
const { aggregate } = require('./insights');
const logger = require('../../utils/logger');

// ─── Quotas ─────────────────────────────────────────────────
const QUOTAS = {
  results:   { limit: 30, overagePack: 50 },  // per mission
  dashboard: { limit: 30, overagePack: 50 },  // per month
  setup:     { limit: 20, overagePack: 50 },  // per session
};
const OVERAGE_PRICE_USD = 5;
const OVERAGE_MESSAGES  = 50;

// ─── Scope → callType routing ───────────────────────────────
const SCOPE_CALLTYPE = {
  results:   'chat_results',
  dashboard: 'chat_dashboard',
  setup:     'chat_setup',
};

// Pass 22 Bug 22.27 — append shared writing-style ban to every chat persona.
const { WRITING_STYLE } = require('./writingStyle');

// ─── System prompts (kept stable so they are prompt-cacheable) ─
const SYSTEM_PROMPTS = {
  results: `You are VETT's Results Copilot. You help the user interrogate completed research.
Style: concise, confident, data-led. Lead with the finding, then the evidence. Never invent numbers, only use data from the context.
If the user asks a question the data can't answer, say so plainly and suggest a follow-up mission.
When quoting percentages or counts, use the aggregated stats supplied below.
${WRITING_STYLE}`,

  dashboard: `You are VETT's Dashboard Copilot. You help the user understand their research portfolio:
what they've run, what's working, what to run next. Be tactical and strategic.
Never fabricate mission IDs, titles or stats, only reference what's in the supplied context.
${WRITING_STYLE}`,

  setup: `You are VETT's Setup Advisor. You help the user design a great research mission BEFORE they launch.
Coach on: sharpening the brief, writing unbiased questions, picking the right audience size, choosing targeting.
Be opinionated. Push back when the user's plan is weak. Offer concrete edits.
${WRITING_STYLE}`,
};

// ─── Quota helpers ─────────────────────────────────────────

/**
 * Find an existing session for (user, scope, mission) or create one.
 * For scope=dashboard the mission is ignored. For scope=setup we key by mission_id too
 * so each Setup Advisor thread belongs to one draft mission.
 */
async function getOrCreateSession({ userId, scope, missionId = null }) {
  let query = supabase
    .from('chat_sessions')
    .select('*')
    .eq('user_id', userId)
    .eq('scope', scope);

  if (scope === 'dashboard') {
    // One rolling session per month
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    query = query.gte('created_at', monthStart.toISOString());
  } else if (missionId) {
    query = query.eq('mission_id', missionId);
  }

  const { data: existing } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (existing) return existing;

  const { data: created, error } = await supabase
    .from('chat_sessions')
    .insert({
      user_id: userId,
      mission_id: missionId,
      scope,
      quota_limit: QUOTAS[scope].limit,
    })
    .select('*')
    .single();

  if (error) throw error;
  return created;
}

/** Quota = base limit + purchased overage. Returns { used, limit, remaining }. */
function computeQuota(session) {
  const limit = (session.quota_limit || 0) + (session.quota_overage_purchased || 0);
  const used = session.messages_count || 0;
  return { used, limit, remaining: Math.max(0, limit - used) };
}

/** Increment the message counter and roll up cost atomically-ish. */
async function bumpSession(sessionId, costUsd) {
  const { data } = await supabase
    .from('chat_sessions')
    .select('messages_count, total_cost_usd')
    .eq('id', sessionId)
    .single();

  if (!data) return;
  await supabase
    .from('chat_sessions')
    .update({
      messages_count:  (data.messages_count || 0) + 1,
      total_cost_usd: (Number(data.total_cost_usd) || 0) + (costUsd || 0),
      updated_at:      new Date().toISOString(),
    })
    .eq('id', sessionId);
}

async function grantOverage(sessionId) {
  const { data } = await supabase
    .from('chat_sessions')
    .select('quota_overage_purchased')
    .eq('id', sessionId)
    .single();
  if (!data) throw new Error('Chat session not found');

  await supabase
    .from('chat_sessions')
    .update({
      quota_overage_purchased: (data.quota_overage_purchased || 0) + OVERAGE_MESSAGES,
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId);
}

// ─── Context builders ──────────────────────────────────────

async function buildResultsContext(missionId, userId) {
  const { data: mission } = await supabase
    .from('missions').select('*')
    .eq('id', missionId).eq('user_id', userId).single();
  if (!mission) return null;

  const { data: responses } = await supabase
    .from('mission_responses')
    .select('persona_id, persona_profile, question_id, answer')
    .eq('mission_id', missionId);

  const agg = aggregate(responses || [], mission.questions || []);
  return {
    mission: {
      id: mission.id, title: mission.title,
      brief: mission.brief || mission.mission_statement,
      respondent_count: mission.respondent_count,
      questions: mission.questions,
    },
    insights: mission.insights || {},
    aggregated: agg,
    responseCount: (responses || []).length,
  };
}

async function buildDashboardContext(userId) {
  const { data: missions } = await supabase
    .from('missions')
    .select('id, title, brief, status, respondent_count, created_at, completed_at, insights')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);

  return {
    missions: (missions || []).map((m) => ({
      id: m.id,
      title: m.title,
      brief: m.brief,
      status: m.status,
      respondent_count: m.respondent_count,
      created_at: m.created_at,
      completed_at: m.completed_at,
      headline: m.insights?.executive_summary?.slice(0, 280) || null,
    })),
  };
}

async function buildSetupContext(missionId, userId) {
  if (!missionId) return { draft: null };
  const { data: mission } = await supabase
    .from('missions').select('*')
    .eq('id', missionId).eq('user_id', userId).single();
  if (!mission) return { draft: null };
  return {
    draft: {
      title: mission.title,
      brief: mission.brief || mission.mission_statement,
      goal_type: mission.goal_type,
      respondent_count: mission.respondent_count,
      targeting: mission.targeting,
      questions: mission.questions,
    },
  };
}

async function buildContext({ scope, userId, missionId }) {
  if (scope === 'results')   return buildResultsContext(missionId, userId);
  if (scope === 'dashboard') return buildDashboardContext(userId);
  if (scope === 'setup')     return buildSetupContext(missionId, userId);
  return {};
}

// ─── Public API ────────────────────────────────────────────

/**
 * Send one message; returns the full reply (non-streaming path).
 * For streaming, see `streamMessage` below.
 */
async function sendMessage({ userId, scope, missionId = null, userMessage }) {
  if (!SCOPE_CALLTYPE[scope]) throw new Error(`Unknown chat scope: ${scope}`);

  const session = await getOrCreateSession({ userId, scope, missionId });
  const quota   = computeQuota(session);
  if (quota.remaining <= 0) {
    return {
      blocked: true, reason: 'quota_exceeded',
      quota, overagePack: OVERAGE_MESSAGES, overagePriceUsd: OVERAGE_PRICE_USD,
      sessionId: session.id,
    };
  }

  // Build prior history (last 20 turns) + user message
  const { data: prior } = await supabase
    .from('chat_messages')
    .select('role, content')
    .eq('session_id', session.id)
    .order('created_at', { ascending: true })
    .limit(40);

  const context = await buildContext({ scope, userId, missionId });
  const contextBlock = `You have access to the following authoritative context. Treat it as ground truth.\n\n${JSON.stringify(context, null, 2)}`;

  const messages = [
    { role: 'user', content: contextBlock },
    { role: 'assistant', content: 'Context loaded — ready to help.' },
    ...(prior || []).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  // Persist the user message BEFORE calling Claude so ordering is stable
  await supabase.from('chat_messages').insert({
    session_id: session.id, role: 'user', content: userMessage,
  });

  const result = await callClaude({
    callType:     SCOPE_CALLTYPE[scope],
    missionId:    missionId,
    userId:       userId,
    messages,
    systemPrompt: SYSTEM_PROMPTS[scope],
    maxTokens:    1500,
    enablePromptCache: true,
  });

  await supabase.from('chat_messages').insert({
    session_id: session.id,
    role: 'assistant',
    content: result.text,
    tokens_in:  result.inputTokens,
    tokens_out: result.outputTokens,
    cost_usd:   result.costUsd,
  });
  await bumpSession(session.id, result.costUsd);

  const updatedQuota = { ...quota, used: quota.used + 1, remaining: Math.max(0, quota.remaining - 1) };

  return {
    blocked: false,
    sessionId: session.id,
    reply: result.text,
    quota: updatedQuota,
    model: result.model,
  };
}

/**
 * Streaming variant. Caller should pipe deltas to the client via SSE.
 * `onDelta(text)` is invoked for each chunk.
 * Returns the same shape as `sendMessage` once the stream closes.
 */
async function streamMessage({ userId, scope, missionId = null, userMessage, onDelta }) {
  if (!SCOPE_CALLTYPE[scope]) throw new Error(`Unknown chat scope: ${scope}`);

  const session = await getOrCreateSession({ userId, scope, missionId });
  const quota   = computeQuota(session);
  if (quota.remaining <= 0) {
    return {
      blocked: true, reason: 'quota_exceeded',
      quota, overagePack: OVERAGE_MESSAGES, overagePriceUsd: OVERAGE_PRICE_USD,
      sessionId: session.id,
    };
  }

  const { data: prior } = await supabase
    .from('chat_messages')
    .select('role, content')
    .eq('session_id', session.id)
    .order('created_at', { ascending: true })
    .limit(40);

  const context = await buildContext({ scope, userId, missionId });
  const contextBlock = `You have access to the following authoritative context. Treat it as ground truth.\n\n${JSON.stringify(context, null, 2)}`;

  const messages = [
    { role: 'user', content: contextBlock },
    { role: 'assistant', content: 'Context loaded — ready to help.' },
    ...(prior || []).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  await supabase.from('chat_messages').insert({
    session_id: session.id, role: 'user', content: userMessage,
  });

  const result = await streamClaude({
    callType:     SCOPE_CALLTYPE[scope],
    missionId:    missionId,
    userId:       userId,
    messages,
    systemPrompt: SYSTEM_PROMPTS[scope],
    maxTokens:    1500,
    onDelta,
  });

  await supabase.from('chat_messages').insert({
    session_id: session.id,
    role: 'assistant',
    content: result.text,
    tokens_in:  result.inputTokens,
    tokens_out: result.outputTokens,
    cost_usd:   result.costUsd,
  });
  await bumpSession(session.id, result.costUsd);

  return {
    blocked: false,
    sessionId: session.id,
    reply: result.text,
    quota: { ...quota, used: quota.used + 1, remaining: Math.max(0, quota.remaining - 1) },
    model: result.model,
  };
}

async function getSessionSummary({ userId, scope, missionId = null }) {
  const session = await getOrCreateSession({ userId, scope, missionId });
  const { data: messages } = await supabase
    .from('chat_messages')
    .select('role, content, created_at')
    .eq('session_id', session.id)
    .order('created_at', { ascending: true });

  return {
    sessionId: session.id,
    scope: session.scope,
    quota: computeQuota(session),
    messages: messages || [],
    overagePack: OVERAGE_MESSAGES,
    overagePriceUsd: OVERAGE_PRICE_USD,
  };
}

module.exports = {
  sendMessage,
  streamMessage,
  getSessionSummary,
  getOrCreateSession,
  grantOverage,
  QUOTAS,
  OVERAGE_PRICE_USD,
  OVERAGE_MESSAGES,
};
