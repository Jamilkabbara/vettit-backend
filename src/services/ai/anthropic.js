/**
 * VETT — Anthropic SDK wrapper with tiered model routing and per-call cost tracking.
 * Every call is logged to public.ai_calls for margin auditing.
 */

const Anthropic = require('@anthropic-ai/sdk');
const supabase = require('../../db/supabase');
const logger = require('../../utils/logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Pricing ($ per 1M tokens).
const MODEL_PRICING = {
  'claude-haiku-4-5':    { input: 0.80,  output: 4.00  },
  'claude-sonnet-4-6':   { input: 3.00,  output: 15.00 },
  'claude-opus-4-7':     { input: 15.00, output: 75.00 },
};

// Pass 34 C3 — call_type → purpose bucket. Mirrors the SQL CASE in
// migrations/pass-34/03_c3_*.sql. Used at write time so every new
// ai_calls row carries `purpose` even when mission_id is null.
const CALL_TYPE_TO_PURPOSE = {
  // Mission-pipeline: usually paired with mission_id, but the tag
  // also covers transit gaps where the mission row hasn't linked yet.
  survey_gen:                   'mission_pipeline',
  persona_gen:                  'mission_pipeline',
  response_sim:                 'mission_pipeline',
  insight_synth:                'mission_pipeline',
  brand_lift_benchmarks:        'mission_pipeline',
  creative_attention_frame:     'mission_pipeline',
  creative_attention_synthesis: 'mission_pipeline',
  results_analysis:             'mission_pipeline',
  // Chatbot surfaces.
  chat_setup:      'chatbot_setup',
  chat_results:    'chatbot_results',
  chat_dashboard:  'chatbot_dashboard',
  chat_admin_crm:  'chatbot_admin',
  // Brief / targeting helpers (run pre-mission or unbound).
  brief_clarify:      'clarify',
  adaptive_clarify:   'clarify',
  question_refine:    'clarify',
  targeting_suggest:  'targeting_brief',
  targeting_brief:    'targeting_brief',
  // Editorial.
  blog_gen: 'blog_gen',
};

function purposeForCallType(callType) {
  return CALL_TYPE_TO_PURPOSE[callType] || 'unknown_legacy';
}

// callType → model routing. Haiku for high-volume/simple; Sonnet for reasoning; Opus reserved for enterprise.
const MODEL_ROUTING = {
  brief_clarify:  'claude-sonnet-4-6',
  survey_gen:     'claude-sonnet-4-6',
  persona_gen:    'claude-haiku-4-5',
  response_sim:   'claude-haiku-4-5',
  insight_synth:  'claude-sonnet-4-6',
  blog_gen:       'claude-sonnet-4-6',
  chat_setup:     'claude-haiku-4-5',
  chat_results:   'claude-sonnet-4-6',
  chat_dashboard: 'claude-sonnet-4-6',
  chat_admin_crm: 'claude-haiku-4-5',
  targeting_suggest: 'claude-sonnet-4-6',
  question_refine:   'claude-haiku-4-5',
  adaptive_clarify:  'claude-haiku-4-5',
  results_analysis:  'claude-sonnet-4-6',
  targeting_brief:              'claude-sonnet-4-6',
  creative_attention_frame:    'claude-sonnet-4-6',  // vision: per-frame emotion analysis
  creative_attention_synthesis: 'claude-sonnet-4-6', // text: aggregate + recommendations
  brand_lift_benchmarks:        'claude-sonnet-4-6', // Pass 25 Phase 1F: AI benchmarks for the brand-lift KPI templates
  // Pass 44 — admin.js _generateInsights has passed this callType since
  // the panel shipped, but it was never routed here; callClaude threw
  // "Unknown AI callType: admin_insights" → GET /api/admin/insights
  // hard-500'd on every cache miss (Agent C audit finding).
  admin_insights:               'claude-sonnet-4-6',
  // Pass 44 — extractSubject (claudeAI.js, BUG-013 helper) passes this
  // callType; routed to Haiku per its design (~$0.005/call). Unrouted
  // it would throw the same way the moment the helper gets wired in.
  subject_extract:              'claude-haiku-4-5',
};

/**
 * Low-level Claude call with cost logging.
 * @param {object} params
 * @param {string} params.callType   - Key of MODEL_ROUTING
 * @param {string} [params.missionId]
 * @param {string} [params.userId]
 * @param {Array}  params.messages   - [{ role, content }]
 * @param {string} [params.systemPrompt]
 * @param {number} [params.maxTokens=2000]
 * @param {boolean}[params.enablePromptCache=false]
 */
async function callClaude({
  callType,
  missionId = null,
  userId    = null,
  messages,
  systemPrompt = '',
  maxTokens    = 2000,
  enablePromptCache = false,
}) {
  const model = MODEL_ROUTING[callType];
  if (!model) throw new Error(`Unknown AI callType: ${callType}`);
  const pricing = MODEL_PRICING[model];
  const start = Date.now();

  try {
    // Build system block — optionally with prompt caching
    const systemParam = enablePromptCache && systemPrompt
      ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
      : systemPrompt;

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemParam,
      messages,
    });

    const inputTokens  = response.usage?.input_tokens  || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    const cachedTokens = response.usage?.cache_read_input_tokens || 0;

    // Cache reads cost 10% of input price; cache writes cost 25% more.
    const baseInputCost   = ((inputTokens - cachedTokens) / 1_000_000) * pricing.input;
    const cachedInputCost = (cachedTokens / 1_000_000) * pricing.input * 0.10;
    const outputCost      = (outputTokens / 1_000_000) * pricing.output;
    const costUsd = baseInputCost + cachedInputCost + outputCost;

    const latencyMs = Date.now() - start;
    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';

    // Log every successful call — non-blocking to the hot path
    supabase.from('ai_calls').insert({
      mission_id: missionId,
      user_id:    userId,
      call_type:  callType,
      // Pass 34 C3 — purpose tag bucketed from call_type so non-mission
      // calls (chatbot, clarify, targeting) stay attributable.
      purpose:    purposeForCallType(callType),
      model,
      input_tokens:  inputTokens,
      output_tokens: outputTokens,
      cached_tokens: cachedTokens,
      cost_usd:      costUsd,
      latency_ms:    latencyMs,
      success:       true,
    }).then(() => {}).catch(err => logger.warn('ai_calls insert failed', err));

    // Pass 42 A3 — roll cost up to the mission for fast margin
    // dashboards AND for the recruit-loop's ceiling check. The new
    // increment_mission_ai_spend RPC (Pass 42 A3 migration) atomically
    // updates BOTH ai_cost_usd (legacy, admin dashboards) and
    // ai_spend_usd_actual (new, recruit-loop reads this). Falls back
    // to the manual SELECT+UPDATE only if the RPC fails so writes
    // continue even during a migration gap.
    if (missionId) {
      supabase.rpc('increment_mission_ai_spend', { p_mission_id: missionId, p_cost: costUsd })
        .then(({ error: rpcErr }) => {
          if (!rpcErr) return;
          // RPC error path: try the legacy single-column RPC
          supabase.rpc('increment_mission_ai_cost', { p_mission_id: missionId, p_cost: costUsd })
            .then(({ error: legacyErr }) => {
              if (!legacyErr) return;
              // Final fallback: manual SELECT+UPDATE on both columns.
              // Racy under high concurrency but better than dropping
              // the cost entirely.
              supabase.from('missions')
                .select('ai_cost_usd, ai_spend_usd_actual')
                .eq('id', missionId)
                .single()
                .then(({ data }) => {
                  if (!data) return;
                  supabase.from('missions')
                    .update({
                      ai_cost_usd:         (Number(data.ai_cost_usd) || 0) + costUsd,
                      ai_spend_usd_actual: (Number(data.ai_spend_usd_actual) || 0) + costUsd,
                    })
                    .eq('id', missionId)
                    .then(() => {})
                    .catch((err) => logger.warn('ai cost manual fallback update failed', { missionId, err: err.message }));
                });
            });
        });
    }

    return { text, costUsd, inputTokens, outputTokens, cachedTokens, latencyMs, model };
  } catch (error) {
    supabase.from('ai_calls').insert({
      mission_id: missionId,
      user_id:    userId,
      call_type:  callType,
      // Pass 34 C3 — purpose tag also written on failed-call rows so
      // failure rates can be bucketed by surface (chatbot vs pipeline).
      purpose:    purposeForCallType(callType),
      model,
      input_tokens:  0,
      output_tokens: 0,
      cost_usd:      0,
      latency_ms:    Date.now() - start,
      success:       false,
      error_message: error.message?.slice(0, 500),
    }).then(() => {}).catch(() => {});

    logger.error('Claude call failed', { callType, model, error: error.message });
    throw error;
  }
}

/**
 * Streaming version — yields text chunks. Used by chat endpoints that proxy SSE to the client.
 * Returns an async iterable + final cost/token totals.
 */
async function streamClaude({
  callType,
  missionId = null,
  userId    = null,
  messages,
  systemPrompt = '',
  maxTokens    = 2000,
  onDelta,
}) {
  const model = MODEL_ROUTING[callType];
  if (!model) throw new Error(`Unknown AI callType: ${callType}`);
  const pricing = MODEL_PRICING[model];
  const start = Date.now();

  let fullText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;

  try {
    const stream = await client.messages.stream({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
    });

    stream.on('text', (chunk) => {
      fullText += chunk;
      if (onDelta) onDelta(chunk);
    });

    const finalResponse = await stream.finalMessage();
    inputTokens  = finalResponse.usage?.input_tokens  || 0;
    outputTokens = finalResponse.usage?.output_tokens || 0;
    cachedTokens = finalResponse.usage?.cache_read_input_tokens || 0;

    const baseInputCost   = ((inputTokens - cachedTokens) / 1_000_000) * pricing.input;
    const cachedInputCost = (cachedTokens / 1_000_000) * pricing.input * 0.10;
    const outputCost      = (outputTokens / 1_000_000) * pricing.output;
    const costUsd = baseInputCost + cachedInputCost + outputCost;

    supabase.from('ai_calls').insert({
      mission_id: missionId,
      user_id:    userId,
      call_type:  callType,
      // Pass 34 C3 — purpose tag for streamed calls (chat copilots).
      purpose:    purposeForCallType(callType),
      model,
      input_tokens:  inputTokens,
      output_tokens: outputTokens,
      cached_tokens: cachedTokens,
      cost_usd:      costUsd,
      latency_ms:    Date.now() - start,
      success:       true,
    }).then(() => {}).catch(() => {});

    return { text: fullText, costUsd, inputTokens, outputTokens, model };
  } catch (error) {
    logger.error('Claude stream failed', { callType, model, error: error.message });
    throw error;
  }
}

/** Parse the first JSON object out of a Claude text response. */
function extractJSON(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in model output');
  return JSON.parse(match[0]);
}

module.exports = {
  callClaude,
  streamClaude,
  extractJSON,
  MODEL_ROUTING,
  MODEL_PRICING,
};
