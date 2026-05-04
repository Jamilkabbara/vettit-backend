/**
 * Pass 25 Phase 1F — AI benchmark service for Brand Lift Studies.
 *
 * Benchmarks (aided awareness norms, ad recall norms, NPS norms, etc.)
 * are AI-estimated from Claude Sonnet, not validated panel data. Each
 * estimate is keyed by (industry, region, channel mix, audience segment,
 * KPI template) and cached for 30 days.
 *
 * The model is explicitly instructed to return `confidence: 'low'` if
 * it doesn't have grounded knowledge for the niche — better to surface
 * uncertainty than to invent tight numbers. Surfaced via the
 * BenchmarkBadge tooltip on every brand-lift result.
 */

const crypto = require('crypto');
const supabase = require('../db/supabase');
const { callClaude, extractJSON } = require('./ai/anthropic');

const SYSTEM_PROMPT = `You are a media-research analyst providing realistic benchmark
estimates for brand-lift KPIs. Output ONLY valid JSON with no commentary.

Schema:
{
  "kpis": {
    "unaided_brand_awareness":     { "value": <0-100>, "unit": "%" },
    "aided_brand_awareness":       { "value": <0-100>, "unit": "%" },
    "unaided_ad_recall":           { "value": <0-100>, "unit": "%" },
    "aided_ad_recall":             { "value": <0-100>, "unit": "%" },
    "brand_familiarity":           { "value": <0-100>, "unit": "%" },
    "brand_favorability":          { "value": <0-100>, "unit": "%" },
    "brand_consideration":         { "value": <0-100>, "unit": "%" },
    "purchase_intent":             { "value": <0-100>, "unit": "%" },
    "nps":                         { "value": <-100-100>, "unit": "score" },
    "message_association":         { "value": <0-100>, "unit": "%" }
  },
  "confidence": "high" | "medium" | "low",
  "rationale": "1-2 sentences on what informs these numbers"
}

CRITICAL: If you don't have grounded knowledge for the specific industry,
region, or channel mix, return confidence: "low" and use middle-of-range
values rather than fabricating tight numbers. Never invent precision.`;

function regionKey({ countries, cities }) {
  const c = Array.isArray(countries) ? [...countries].sort() : [];
  const ci = Array.isArray(cities) ? [...cities].sort() : [];
  return JSON.stringify({ c, ci });
}

function channelMixHash(channelIds) {
  const sorted = (channelIds || []).slice().sort();
  return crypto.createHash('sha1').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
}

function isFresh(row) {
  if (!row || !row.expires_at) return false;
  return new Date(row.expires_at).getTime() > Date.now();
}

function validateKpiSet(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const k = obj.kpis;
  if (!k || typeof k !== 'object') return false;
  for (const [key, v] of Object.entries(k)) {
    if (typeof v?.value !== 'number') return false;
    if (key === 'nps') {
      if (v.value < -100 || v.value > 100) return false;
    } else if (v.value < 0 || v.value > 100) return false;
  }
  if (!['high', 'medium', 'low'].includes(obj.confidence)) return false;
  return true;
}

/**
 * Get a benchmark set, hitting the cache when possible.
 *
 * @param {object} input
 * @param {string} input.industry
 * @param {object} input.region              { countries: [], cities: [] }
 * @param {string[]} input.channels          channel_ids from channels_master
 * @param {string} [input.audience]          freeform segment label
 * @param {string} input.kpi_template        funnel_overview, etc.
 * @param {string} [input.missionId]
 * @param {string} [input.userId]
 * @returns {Promise<{benchmarks, source, confidence, cached}>}
 */
async function getBenchmarks(input) {
  const region_key = regionKey(input.region || {});
  const channel_mix_hash = channelMixHash(input.channels || []);
  const audience_segment = (input.audience || '').slice(0, 200);
  const lookup = {
    industry: input.industry || 'general',
    region_key,
    channel_mix_hash,
    audience_segment,
    kpi_template: input.kpi_template || 'funnel_overview',
  };

  const { data: hit } = await supabase
    .from('brand_lift_benchmarks')
    .select('*')
    .match(lookup)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (hit && isFresh(hit)) {
    return { benchmarks: hit.benchmarks, source: hit.source, confidence: hit.confidence, cached: true };
  }

  const userMessage = `Industry: ${input.industry || 'unspecified'}
Region (countries/cities): ${region_key}
Channel mix: ${(input.channels || []).join(', ') || 'unspecified'}
Audience segment: ${audience_segment || 'general'}
KPI template: ${lookup.kpi_template}

Return realistic brand-lift benchmark estimates per the schema.`;

  const raw = await callClaude({
    callType:  'brand_lift_benchmarks',
    missionId: input.missionId,
    userId:    input.userId,
    messages:  [{ role: 'user', content: userMessage }],
    systemPrompt: SYSTEM_PROMPT,
    maxTokens: 1200,
  });
  const parsed = extractJSON(raw);
  if (!validateKpiSet(parsed)) {
    throw new Error('brand_lift_benchmarks: model output failed schema validation');
  }

  await supabase.from('brand_lift_benchmarks').insert({
    ...lookup,
    benchmarks: parsed.kpis,
    source: 'ai_estimate',
    confidence: parsed.confidence,
  });

  return { benchmarks: parsed.kpis, source: 'ai_estimate', confidence: parsed.confidence, cached: false };
}

module.exports = { getBenchmarks, regionKey, channelMixHash };
