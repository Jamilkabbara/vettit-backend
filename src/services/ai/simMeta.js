/**
 * Simulation-honesty metadata — single source for the simulation's sampling
 * parameters and version stamp.
 *
 * SIM_VERSION history:
 *   2026.08-emergent-lift — brand-lift uplift ranges REMOVED from the
 *     simulation prompt (they previously dictated +20-40pp recall etc., so
 *     measured lift partially recovered prompt-injected numbers). Lift is now
 *     an emergent model property; qualitative realism guardrails remain.
 *     Missions stamped with an earlier/absent version are NOT comparable with
 *     missions from this version on brand-lift level metrics.
 *
 * DEFAULT_SIM_TEMPERATURE: the explicit sampling temperature for persona
 * generation + respondent simulation. 1.0 matches the Anthropic API default
 * the pipeline has always implicitly run at — making it explicit changes no
 * behavior, but documents it, stamps it into mission metadata for audit, and
 * gives one place to tune it. (Lowering it would make runs more repeatable at
 * the cost of collapsing persona variance — do not chase determinism here;
 * the API exposes no sampling seed, so bit-exact re-simulation is impossible
 * regardless.)
 */

// Fallback {} keeps this module safe under test mocks of ./anthropic.
const { MODEL_ROUTING = {} } = require('./anthropic');

const SIM_VERSION = '2026.08-emergent-lift';
const DEFAULT_SIM_TEMPERATURE = 1.0;

/**
 * Audit stamp attached to mission insights at synthesis time
 * (insights._sim_meta). Everything needed to interpret or re-audit the run:
 * which models answered, at what temperature, under which sim version.
 */
function buildSimMeta() {
  return {
    sim_version: SIM_VERSION,
    temperature: DEFAULT_SIM_TEMPERATURE,
    models: {
      persona_gen: MODEL_ROUTING.persona_gen,
      response_sim: MODEL_ROUTING.response_sim,
      survey_gen: MODEL_ROUTING.survey_gen,
    },
    stamped_at: new Date().toISOString(),
  };
}

module.exports = { SIM_VERSION, DEFAULT_SIM_TEMPERATURE, buildSimMeta };
