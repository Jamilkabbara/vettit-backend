/**
 * Un-gate readiness (audience_profiling): the public social-proof ticker in
 * GET /missions builds each line from VETTED_CATEGORY_LABELS[goal_type] and
 * `continue`s (drops the mission) whenever the label is undefined. Before this
 * fix a live audience_profiling mission was silently invisible in the ticker.
 * This locks a real label in place so the un-gate flip does not regress it.
 *
 * market_entry is intentionally NOT asserted here — it un-gates on its own
 * track (Agent F) and stays absent until then.
 */
// Short-circuit the heavy job/email chain (missions.js -> runMission ->
// email.js -> Resend, which throws without an API key) so we can require the
// route purely for its exported label map.
jest.mock('../src/jobs/runMission', () => ({ runMission: jest.fn() }));

const missionsRouter = require('../src/routes/missions');
const LABELS = missionsRouter.VETTED_CATEGORY_LABELS;

describe('social-proof ticker label coverage', () => {
  test('audience_profiling has a real ticker label', () => {
    expect(LABELS).toBeDefined();
    expect(LABELS.audience_profiling).toBe('Audience Profiling');
  });

  test('every live (non coming-soon) goal type has a ticker label', () => {
    const { COMING_SOON_GOAL_TYPES } = require('../src/config/comingSoon');
    // audience_profiling is still gated today but MUST already carry a label so
    // the un-gate is a pure gate flip with no ticker regression.
    const stillGated = new Set(
      [...COMING_SOON_GOAL_TYPES].filter((g) => g !== 'audience_profiling'),
    );
    const liveTypes = [
      'research', 'validate', 'compare', 'marketing', 'satisfaction',
      'pricing', 'roadmap', 'competitor', 'naming_messaging', 'churn_research',
      'brand_lift', 'creative_attention', 'audience_profiling',
    ].filter((g) => !stillGated.has(g));
    for (const g of liveTypes) {
      expect(typeof LABELS[g]).toBe('string');
      expect(LABELS[g].length).toBeGreaterThan(0);
    }
  });
});
