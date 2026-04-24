/**
 * Shared helpers for all export formats (PDF, PPTX, XLSX).
 * All exports pull from mission_responses (synthetic pipeline) — never Pollfish.
 */

const supabase = require('../../db/supabase');
const { aggregate } = require('../ai/insights');

/**
 * Load everything needed to build an export for a mission, in one trip.
 * Returns null if the mission isn't the user's or isn't exportable yet.
 *
 * Bug 1/2 fix: screening question aggregation must include ALL respondents
 * (both screened-in and screened-out) so the distribution is honest.
 * Non-screening questions only count qualified respondents.
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
    .select('persona_id, persona_profile, question_id, answer, screened_out')
    .eq('mission_id', missionId);

  const allResponses = responses || [];

  // ── Screening funnel ───────────────────────────────────────────────────────
  // Prefer the first-class screened_out column; fall back to persona_profile
  // JSONB for rows inserted before the migration (backfill handles most cases).
  const seenPersonas = new Map();  // persona_id → screened_out bool
  for (const r of allResponses) {
    if (!seenPersonas.has(r.persona_id)) {
      const fromColumn  = r.screened_out === true;
      const fromProfile = Boolean((r.persona_profile || {}).screened_out);
      seenPersonas.set(r.persona_id, fromColumn || fromProfile);
    }
  }
  const totalPersonas    = seenPersonas.size;
  const screenedOutCount = [...seenPersonas.values()].filter(Boolean).length;
  const passedCount      = totalPersonas - screenedOutCount;

  // Only expose funnel data if at least one question has isScreening=true
  const questions    = mission.questions || [];
  const hasScreeningQ = questions.some(q => q.isScreening);
  const screeningFunnel = hasScreeningQ
    ? { total: totalPersonas, passed: passedCount, screenedOut: screenedOutCount }
    : null;
  // ─────────────────────────────────────────────────────────────────────────

  // Qualified-only responses — used for non-screening question aggregation
  const qualifiedResponses = allResponses.filter(r => {
    const fromColumn  = r.screened_out === true;
    const fromProfile = Boolean((r.persona_profile || {}).screened_out);
    return !(fromColumn || fromProfile);
  });

  // Bug 1/2: pass both response sets so screening questions can use allResponses
  return {
    mission,
    responses: allResponses,
    insights:  mission.insights || {},
    aggregatedByQuestion: aggregateWithScreeningAware(
      allResponses,
      qualifiedResponses,
      questions,
    ),
    screeningFunnel,
    // Sample metrics for insights prompt (Bug 4/5)
    sampleMetrics: {
      total_respondents:    totalPersonas,
      screened_out:         screenedOutCount,
      completed:            passedCount,
      response_records_total: allResponses.length,
    },
  };
}

/**
 * Aggregate responses with screening awareness.
 *
 * Screening questions  → use ALL responses (shows the full funnel split).
 * Non-screening questions → use only qualified responses.
 *
 * This ensures exports honestly show, e.g., "6 of 10 selected multiple cats"
 * on the screener question rather than hiding the screened-out segment.
 */
function aggregateWithScreeningAware(allResponses, qualifiedResponses, questions) {
  const result = {};
  for (const q of questions) {
    const responsesToUse = q.isScreening ? allResponses : qualifiedResponses;
    const singleQ = aggregate(responsesToUse, [q]);
    result[q.id] = {
      ...singleQ[q.id],
      // Tag so renderers can add "n_total / n_qualified" context
      is_screening: Boolean(q.isScreening),
      n_total: q.isScreening ? allResponses.filter(r => r.question_id === q.id).length : undefined,
    };
  }
  return result;
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
