/**
 * Creative Attention market context - QUALITATIVE ONLY, by construction.
 *
 * WHY IT IS A SEPARATE STEP
 * -------------------------
 * The owner's rule: market may improve the cultural read and the placement
 * advice, and must not change any number. We hold no per-market attention
 * data, so a market-adjusted score would be a benchmark we do not have.
 *
 * An instruction in a prompt ("do not let the market change the scores") is a
 * hope, not a guarantee. So the market is kept out of every prompt that
 * produces a number. The frame and synthesis calls never see it; every score,
 * the attention prediction and the placement benchmark are final before this
 * step runs. This step then receives the finished qualitative read and returns
 * text only, and anything in its output that contains a digit is dropped, so a
 * market-flavoured statistic cannot slip into the report either.
 *
 * test/ca_market_qualitative.test.js runs the whole analysis with a model stub
 * that deliberately changes its numbers when it can see the market, and fails
 * if any number differs between markets.
 *
 * Failure here never fails a paid mission: the analysis is complete without
 * it, so a failed call is logged and the report ships without market notes.
 */
'use strict';

const LIST_KEYS = ['cultural_fit', 'localisation_risks', 'placement_notes'];
const MAX_ITEMS = 3;
// A note is one sentence (the prompt says so), so it is never cut mid-sentence.
// The old 280-character cut ended 3 of 18 real notes with "…" part-way
// through a clause. Anything longer than MAX_LEN is trimmed back to its last
// complete sentence; an item with no sentence end inside the limit is dropped.
// MAX_LEN only guards against a runaway item; real notes ran 225 to 290.
const MAX_LEN = 600;

function fitNote(s) {
  if (s.length <= MAX_LEN) return s;
  const head = s.slice(0, MAX_LEN);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  return end > 0 ? head.slice(0, end + 1) : null;
}

const MARKET_SYSTEM = `You are a senior regional creative strategist. You advise on how a marketing creative will read culturally in a specific market, what localisation risks it carries there, and how the chosen placement is used in that market. You write plainly and specifically. You never give scores, percentages, durations, rankings or any other figure.`;

/** The market row for a code, or null when the code is not a known market. */
async function resolveMarket(supabase, code) {
  if (typeof code !== 'string' || !code.trim()) return null;
  const { data, error } = await supabase
    .from('markets_master')
    .select('code, display_name')
    .eq('code', code.trim())
    .maybeSingle();
  if (error || !data) return null;
  return { code: data.code, name: data.display_name };
}

function buildMarketContextPrompt({ brandName, audience, brief, keyMessage, market, placement, qualitative }) {
  const bullets = (arr) => (Array.isArray(arr) && arr.length ? arr.map((s) => `- ${s}`).join('\n') : '- none');
  return `A creative has already been analysed. Its scores are final and are not shown to you. Advise on how it will land in one market.

Market: ${market.name}
Brand: ${brandName || 'unknown'}
Target audience: ${audience || 'not specified'}
Campaign brief: ${brief || 'not specified'}
Key message: ${keyMessage || 'not specified'}
Chosen placement: ${placement ? placement.label : 'not specified'}

What the analysis found:
Strengths:
${bullets(qualitative.strengths)}
Weaknesses:
${bullets(qualitative.weaknesses)}

Return ONLY JSON (no prose, no markdown fences):
{
  "cultural_fit": ["How the creative's imagery, tone and message will read culturally in ${market.name}"],
  "localisation_risks": ["A specific risk for ${market.name}: language, modesty, religious or seasonal timing, regulation, or local competitors"],
  "placement_notes": ["How ${placement ? placement.label : 'the likely placements'} is used by audiences in ${market.name}"]
}

Rules:
- One to three items per list. Each item one sentence, specific to this creative and this market.
- No numbers of any kind. No scores, percentages, seconds, counts, rankings, dates or prices.
- Do not restate or re-score the analysis. Add only what the market changes about how to read it.
- Do not invent statistics about the market.`;
}

/**
 * Keep only strings; drop any item carrying a digit; normalise dashes to the
 * house hyphen; cap length and count. Returns null when nothing survives.
 */
function sanitizeMarketContext(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const out = {};
  let kept = 0;
  for (const key of LIST_KEYS) {
    const items = Array.isArray(parsed[key]) ? parsed[key] : [];
    out[key] = items
      .filter((s) => typeof s === 'string')
      .map((s) => s.replace(/\s*[—–]\s*/g, ' - ').replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 0 && !/\d/.test(s))
      .map(fitNote)
      .filter(Boolean)
      .slice(0, MAX_ITEMS);
    kept += out[key].length;
  }
  return kept > 0 ? out : null;
}

/**
 * @param {object} deps           { callClaude, extractJSON, logger }
 * @param {object} args
 * @param {object} args.mission
 * @param {{code,name}} args.market
 * @param {object|null} args.placement
 * @param {string|null} args.audience
 * @param {object} args.qualitative  { strengths, weaknesses } from the finished summary
 */
async function generateMarketContext(deps, { mission, market, placement, audience, qualitative }) {
  const { callClaude, extractJSON, logger } = deps;
  if (!market) return null;
  try {
    const result = await callClaude({
      callType:     'creative_attention_market_context',
      systemPrompt: MARKET_SYSTEM,
      messages:     [{
        role: 'user',
        content: buildMarketContextPrompt({
          brandName:  mission.brand_name,
          audience,
          brief:      mission.brief,
          keyMessage: mission.key_message,
          market,
          placement,
          qualitative: qualitative || {},
        }),
      }],
      missionId: mission.id,
      userId:    mission.user_id,
      maxTokens: 800,
    });
    return sanitizeMarketContext(extractJSON(result.text));
  } catch (err) {
    logger.warn('[CreativeAttention] market context skipped', {
      missionId: mission.id, market: market.code, err: err && err.message,
    });
    return null;
  }
}

module.exports = {
  resolveMarket,
  buildMarketContextPrompt,
  sanitizeMarketContext,
  generateMarketContext,
  MARKET_CONTEXT_KEYS: LIST_KEYS,
};
