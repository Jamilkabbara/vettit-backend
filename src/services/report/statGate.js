/*
 * WO §2.4 — statistical-integrity gate. THE single source of truth for whether
 * a methodology's signature result may be presented as an authoritative number
 * or only as a directional signal at the sample size actually achieved.
 *
 * The canonical report attaches the gate to the centerpiece (buildReport.js), so
 * web + PDF + PPTX + XLSX all read the SAME honesty verdict and none of them can
 * headline a degenerate figure. This fixes the live gap where the analysis layer
 * computed *_degenerate_reason flags that NOTHING downstream ever consumed, and
 * where a clean-but-tiny sample (e.g. an OPP from n=5) printed as if confident.
 *
 * Thresholds (owner-confirmed, WO §2.4):
 *   pricing  (Van Westendorp / Gabor-Granger)  n ≥ 30  → authoritative OPP/curves
 *   roadmap  (MaxDiff / Kano)                   n ≥ 30  → authoritative utilities
 *   audience_profiling (segmentation)           n ≥ 50  → cluster; else aggregate
 *   market_entry (light VW/Gabor)               n ≥ 30  → authoritative WTP/demand
 *   satisfaction / brand_lift / compare /        any n, but always show n + a
 *     competitor / naming / marketing / churn /  confidence note; recommend ≥30
 *     validate
 *
 * A method whose analysis flagged it incomputable (*_degenerate_reason set) is
 * directional regardless of n.
 *
 * `suppress_headline` is true only for the HARD-gated methods below threshold —
 * those whose single point estimate (OPP, top feature utility, segment sizes)
 * must NOT be shown as a confident headline. Soft-gated methods keep their
 * number but carry the directional note.
 */

// Methods whose PRIMARY point metric must not be headlined below threshold.
const HARD_GATES = {
  pricing: 30,
  roadmap: 30,
  market_entry: 30,
  audience_profiling: 50,
};

const HARD_NOTE = {
  pricing: 'Sample too small for a reliable price point — read the acceptable range as direction, not a fixed optimal price.',
  roadmap: 'Sample too small for reliable feature utilities — read the priority order, not the point scores.',
  market_entry: 'Sample too small for a reliable demand or willingness-to-pay estimate — read these as directional signal.',
  audience_profiling: 'Sample too small to segment reliably — an aggregate profile is shown instead of distinct clusters.',
};

// Recommended sample sizes surfaced at setup (WO §2.4 — recommend, don't force).
const RECOMMENDED_N = {
  pricing: 30,
  roadmap: 30,
  audience_profiling: 50,
  market_entry: 30,
  satisfaction: 30,
  brand_lift: 30,
  validate: 30,
  compare: 30,
  competitor: 30,
  naming_messaging: 30,
  marketing: 30,
  churn_research: 30,
  creative_attention: 30,
  research: 30,
};

const SOFT_THRESHOLD = 30;

function degenerateReason(analysis) {
  if (!analysis || typeof analysis !== 'object') return null;
  const keys = ['van_westendorp_degenerate_reason', 'gabor_granger_degenerate_reason',
    'maxdiff_degenerate_reason', 'kano_degenerate_reason', 'degenerate_reason'];
  for (const k of keys) {
    const v = analysis[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

/**
 * @param {string} methodology  mission goal_type
 * @param {object|null} analysis  deterministic analysis block (centerpiece.data)
 * @param {number|null} n  distinct respondent count
 * @returns {{posture:'authoritative'|'directional', note:string|null,
 *            suppress_headline:boolean, threshold:number, n:number, reason:string|null}}
 */
function computeStatGate(methodology, analysis, n) {
  const N = (Number.isFinite(Number(n)) && Number(n) > 0)
    ? Number(n)
    : ((analysis && Number(analysis.n)) || 0);
  const hard = HARD_GATES[methodology] || null;
  const degenerate = degenerateReason(analysis);

  if (degenerate) {
    return { posture: 'directional', note: capitalize(degenerate), suppress_headline: !!hard, threshold: hard || SOFT_THRESHOLD, n: N, reason: 'incomputable' };
  }
  // No sample at all. This MUST come before the soft-base branch, whose
  // condition is `N > 0 && N < SOFT_THRESHOLD` - zero fails the `N > 0` test
  // and fell all the way through to `authoritative`. The gate was strictly
  // LESS honest at n=0 than at n=5: five responses read "directional", zero
  // read "authoritative" with the headline shown.
  //
  // Reachable today, not hypothetical: any mission whose responses all fail
  // to persist lands here, and hard-gated methodologies were only protected
  // by accident, because `hard && N < hard` happens to catch zero first.
  //
  // Zero evidence is the MOST suppressed state, not the least.
  if (!(N > 0)) {
    return {
      posture: 'directional',
      note: 'No respondent data was recorded for this mission, so no figure here is supported by a sample.',
      suppress_headline: true,
      threshold: hard || SOFT_THRESHOLD,
      n: 0,
      reason: 'no_sample',
    };
  }
  if (hard && N < hard) {
    return { posture: 'directional', note: HARD_NOTE[methodology], suppress_headline: true, threshold: hard, n: N, reason: 'below_threshold' };
  }
  if (N > 0 && N < SOFT_THRESHOLD) {
    return { posture: 'directional', note: `Directional read at n=${N} — strong on ranking and consensus, indicative on point magnitudes. We recommend n≥${SOFT_THRESHOLD} for confident estimates.`, suppress_headline: false, threshold: SOFT_THRESHOLD, n: N, reason: 'small_base' };
  }
  return { posture: 'authoritative', note: null, suppress_headline: false, threshold: hard || SOFT_THRESHOLD, n: N, reason: null };
}

module.exports = { computeStatGate, RECOMMENDED_N, HARD_GATES };
