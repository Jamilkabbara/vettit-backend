/**
 * Shared helpers for all export formats (PDF, PPTX, XLSX).
 * All exports pull from mission_responses (synthetic pipeline) — never Pollfish.
 */

const supabase = require('../../db/supabase');
const { aggregate } = require('../ai/insights');

/**
 * Load everything needed to build an export for a mission, in one trip.
 * Returns null if the mission isn't the user's or isn't exportable yet.
 */
async function loadMissionForExport(missionId, userId) {
  const { data: mission } = await supabase
    .from('missions')
    .select('*')
    .eq('id', missionId)
    .eq('user_id', userId)
    .single();

  if (!mission) return null;
  if (mission.status !== 'completed') {
    return { error: 'Results not ready yet — mission is not complete' };
  }

  const { data: responses } = await supabase
    .from('mission_responses')
    .select('persona_id, persona_profile, question_id, answer')
    .eq('mission_id', missionId);

  return {
    mission,
    responses: responses || [],
    insights: mission.insights || {},
    aggregatedByQuestion: aggregate(responses || [], mission.questions || []),
  };
}

// VETT brand palette
const BRAND = {
  bg:      '#0B0C15',
  bg2:     '#111827',
  bg3:     '#1a2233',
  border:  '#1f2937',
  text1:   '#e5e7eb',
  text2:   '#9ca3af',
  text3:   '#6b7280',
  lime:    '#BEF264',
  limeSoft:'#84cc16',
  green:   '#4ade80',
  red:     '#f87171',
  orange:  '#fb923c',
  purple:  '#a78bfa',
  blue:    '#60a5fa',
};

module.exports = { loadMissionForExport, BRAND };
