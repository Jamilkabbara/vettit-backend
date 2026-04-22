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
      model,
      input_tokens:  inputTokens,
      output_tokens: outputTokens,
      cached_tokens: cachedTokens,
      cost_usd:      costUsd,
      latency_ms:    latencyMs,
      success:       true,
    }).then(() => {}).catch(err => logger.warn('ai_calls insert failed', err));

    // Roll cost up to the mission for fast margin dashboards
    if (missionId) {
      supabase.rpc('increment_mission_ai_cost', { p_mission_id: missionId, p_cost: costUsd })
        .then(() => {})
        .catch(() => {
          // Fallback: manual update if RPC not present
          supabase.from('missions').select('ai_cost_usd').eq('id', missionId).single()
            .then(({ data }) => {
              if (data) {
                supabase.from('missions')
                  .update({ ai_cost_usd: (Number(data.ai_cost_usd) || 0) + costUsd })
                  .eq('id', missionId).then(() => {}).catch(() => {});
              }
            });
        });
    }

    return { text, costUsd, inputTokens, outputTokens, cachedTokens, latencyMs, model };
  } catch (error) {
    supabase.from('ai_calls').insert({
      mission_id: missionId,
      user_id:    userId,
      call_type:  callType,
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
