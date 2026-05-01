/**
 * VETT — Creative Attention export shared loader.
 *
 * Pass 23 Bug 23.74: CA missions store everything inside missions.creative_analysis
 * (JSONB populated by services/ai/creativeAttention.js). No mission_responses
 * round-trip is needed — the AI pipeline already aggregated frame-level
 * scores into a single object. This loader just authorizes + validates.
 */

const supabase = require('../../../db/supabase');
const { BRAND } = require('../shared');

async function loadCreativeAttentionForExport(missionId, userId) {
  const { data: mission } = await supabase
    .from('missions')
    .select('*')
    .eq('id', missionId)
    .eq('user_id', userId)
    .single();

  if (!mission) return null;

  if (mission.goal_type && mission.goal_type !== 'creative_attention') {
    return { error: 'This export is only available for Creative Attention missions' };
  }

  if (!mission.creative_analysis) {
    if (mission.status === 'failed') {
      return { error: 'Creative analysis failed for this mission' };
    }
    return { error: 'Creative analysis not ready yet' };
  }

  return { mission, analysis: mission.creative_analysis };
}

// Average helper used by both pptx and xlsx for the Brand Strength derivation.
function avg(vals) {
  if (!vals || vals.length === 0) return 0;
  return Math.round(vals.reduce((a, b) => a + (b || 0), 0) / vals.length);
}

// Pass 23 Bug 23.57 Memory derivation — synthesized from recall-driving
// emotions (trust + surprise + anticipation). Mirrors the frontend
// CreativeAttentionResultsPage logic so exports and the live page agree.
function brandStrength(analysis) {
  const frames = analysis.frame_analyses || [];
  const summary = analysis.summary || {};
  const engagement = summary.overall_engagement_score
    ?? avg(frames.map((f) => f.engagement_score));
  const resonance = avg(frames.map((f) => f.audience_resonance));
  const clarity = avg(frames.map((f) => f.message_clarity));
  const memory = avg(frames.map((f) => {
    const e = f.emotions || {};
    return Math.round(((e.trust || 0) + (e.surprise || 0) + (e.anticipation || 0)) / 3);
  }));
  return { engagement, resonance, clarity, memory };
}

function platformLabel(p) {
  if (typeof p === 'string') return p;
  if (p && typeof p === 'object') return String(p.platform || '');
  return '';
}

function platformRationale(p) {
  if (p && typeof p === 'object') return String(p.rationale || '');
  return '';
}

function caExportFilename(mission, ext) {
  const idShort = String(mission.id || 'mission').slice(0, 8);
  const slug = String(mission.title || 'creative-attention')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'creative-attention';
  const date = new Date().toISOString().slice(0, 10);
  return `vett-${slug}-${idShort}-${date}.${ext}`;
}

module.exports = {
  loadCreativeAttentionForExport,
  brandStrength,
  platformLabel,
  platformRationale,
  caExportFilename,
  BRAND,
};
