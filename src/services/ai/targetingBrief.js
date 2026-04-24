'use strict';
/**
 * targetingBrief.js — AI-generated paid media targeting brief.
 *
 * Reads demographic distribution from mission responses and AI insights,
 * then asks Claude to produce platform-specific targeting specs for
 * Meta Ads, Google Ads, and LinkedIn — ready to paste into an ad platform.
 */

const { callClaude } = require('./anthropic');

/**
 * Generate a targeting brief JSON for a completed mission.
 *
 * @param {object} params
 * @param {object} params.mission     - Mission row from DB (id, title, brief, goal_type, user_id, respondent_count)
 * @param {Array}  params.responses   - Response rows; each may have a persona_profile object
 * @param {object|string|null} params.insights - mission.ai_insights (JSON or string)
 * @returns {Promise<object>} - Structured brief JSON
 */
async function generateTargetingBrief({ mission, responses, insights }) {
  // ── Build demographic distributions ─────────────────────────────────────

  const personas = (responses || [])
    .map(r => r.persona_profile || {})
    .filter(p => p.age || p.gender || p.country);

  const ageBuckets        = { '18-24': 0, '25-34': 0, '35-44': 0, '45-54': 0, '55+': 0 };
  const countryDist       = {};
  const genderDist        = {};
  const occupationSample  = new Set();

  for (const p of personas) {
    if (typeof p.age === 'number') {
      const bucket =
        p.age < 25 ? '18-24' :
        p.age < 35 ? '25-34' :
        p.age < 45 ? '35-44' :
        p.age < 55 ? '45-54' : '55+';
      ageBuckets[bucket] = (ageBuckets[bucket] || 0) + 1;
    }
    if (p.gender)     genderDist[p.gender]   = (genderDist[p.gender] || 0) + 1;
    if (p.country)    countryDist[p.country] = (countryDist[p.country] || 0) + 1;
    if (p.occupation) occupationSample.add(p.occupation);
  }

  // ── Normalise insights to a readable string ──────────────────────────────

  let insightsText = '';
  if (typeof insights === 'string') {
    insightsText = insights.slice(0, 2000);
  } else if (insights && typeof insights === 'object') {
    // Flatten common shapes: {executive_summary, key_findings[], recommendations[]}
    const parts = [];
    if (insights.executive_summary) parts.push(insights.executive_summary);
    if (Array.isArray(insights.key_findings)) {
      parts.push(...insights.key_findings.map(f =>
        typeof f === 'string' ? f : (f.title ? `${f.title}: ${f.description || ''}` : JSON.stringify(f))
      ));
    }
    if (Array.isArray(insights.recommendations)) {
      parts.push(...insights.recommendations.map(r =>
        typeof r === 'string' ? r : (r.text || r.action || JSON.stringify(r))
      ));
    }
    insightsText = parts.join('\n').slice(0, 2000);
  }

  // ── Prompt ───────────────────────────────────────────────────────────────

  const prompt = `You are a senior paid media strategist. Generate a practical targeting brief based on this VETT market research mission.

MISSION DETAILS:
- Title: ${mission.title || 'Untitled'}
- Goal type: ${(mission.goal_type || '').replace(/_/g, ' ')}
- Brief: ${(mission.brief || '').slice(0, 500)}
- Total respondents: ${mission.respondent_count || personas.length}

RESPONDENT DEMOGRAPHICS (${personas.length} persona records):
- Age distribution: ${JSON.stringify(ageBuckets)}
- Gender: ${JSON.stringify(genderDist)}
- Countries: ${JSON.stringify(countryDist)}
- Sample occupations (up to 10): ${[...occupationSample].slice(0, 10).join(', ') || 'not available'}

KEY RESEARCH INSIGHTS:
${insightsText || 'No structured insights available — infer from demographics.'}

Return ONLY a valid JSON object with these exact fields. No markdown fences, no preamble:

{
  "icp_summary": "2-3 sentence ICP description",
  "meta_ads": {
    "locations": ["Country1", "Country2"],
    "age_range": "25-44",
    "gender": "All",
    "interests": ["interest1", "interest2", "interest3", "interest4", "interest5"],
    "behaviors": ["behavior1", "behavior2"],
    "exclusions": ["exclusion1"]
  },
  "google_ads": {
    "keywords": ["kw1", "kw2", "kw3", "kw4", "kw5", "kw6", "kw7", "kw8"],
    "negative_keywords": ["neg1", "neg2"],
    "audiences": ["In-market: Category X", "Affinity: Category Y"]
  },
  "linkedin_ads": {
    "industries": ["Industry1", "Industry2"],
    "job_titles": ["Title1", "Title2", "Title3"],
    "seniorities": ["Manager", "Senior", "Director"],
    "job_functions": ["Function1", "Function2"],
    "company_sizes": ["51-200", "201-500"]
  },
  "lookalike_seed": "2-3 sentences on building lookalike audiences from top responders",
  "ad_copy_angles": [
    "Angle 1 — 1-2 sentences on emotional hook or value prop",
    "Angle 2 — ...",
    "Angle 3 — ..."
  ]
}

Rules:
- Use real interest/industry names that actually exist on those ad platforms (e.g. "Small business owners" not "Business type 1")
- Age range should reflect the top 2 age buckets in the demographic data
- Locations should be the top countries by respondent count
- Be specific and actionable — a media buyer should be able to paste this directly into Ads Manager
- Return ONLY the JSON, nothing else`;

  // ── Call Claude ──────────────────────────────────────────────────────────

  const result = await callClaude({
    callType:    'targeting_brief',
    missionId:   mission.id,
    userId:      mission.user_id,
    messages:    [{ role: 'user', content: prompt }],
    systemPrompt: 'You are a paid media strategist. Always respond with valid JSON only — no markdown, no explanation.',
    maxTokens:   2000,
    enablePromptCache: false,
  });

  // ── Parse ────────────────────────────────────────────────────────────────

  const raw = (result.text || result.content || '').trim();
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  let brief;
  try {
    brief = JSON.parse(cleaned);
  } catch (parseErr) {
    throw new Error(`AI returned invalid JSON for targeting brief (missionId=${mission.id}): ${parseErr.message}\nRaw: ${cleaned.slice(0, 300)}`);
  }

  return brief;
}

module.exports = { generateTargetingBrief };
