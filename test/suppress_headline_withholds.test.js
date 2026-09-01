/**
 * Pass 49 — `suppress_headline` must actually withhold the figure.
 *
 * THE DEFECT
 * ----------
 * statGate set suppress_headline correctly for the HARD-gated methods below
 * threshold (pricing/roadmap/market_entry n<30, audience_profiling n<50), and
 * NOTHING acted on it:
 *   - no exporter referenced it at all (grep of src/services/exports: 0 hits)
 *   - on the web its only effect was one CSS rule,
 *       .premium .cp-damp .mv.lime { color: var(--muted) }
 *     which greyed the number and left it on screen at full size.
 * So the flag was computed, was correct, and suppressed nothing anywhere,
 * while the public methodology page was about to claim it did.
 *
 * Suppression now happens in buildRenderModel, not in four renderers:
 * `headline: null` is already a state pptx.js, xlsx.js and the pdf-v2
 * template all guard on, so every export inherits it and any future exporter
 * gets it for free.
 */

const { buildRenderModel } = require('../src/services/report/reportRenderModel');

const HEADLINE = { metric: 'Optimal price', value: '$42', all: [
  { label: 'Optimal price', value: '$42' },
  { label: 'Acceptable range', value: '$30-$55' },
] };

const base = (gate) => ({
  title: 'T',
  headline: HEADLINE,
  centerpiece: { gate },
  key_findings: [{ title: 'kf', description: 'd' }],
  personas: [{ name: 'p' }],
});

const GATE_SUPPRESSED = {
  posture: 'directional', note: 'Sample too small for a reliable price point.',
  suppress_headline: true, threshold: 30, n: 5, reason: 'below_threshold',
};
const GATE_SOFT = {
  posture: 'directional', note: 'Directional read at n=12.',
  suppress_headline: false, threshold: 30, n: 12, reason: 'small_base',
};
const GATE_OK = {
  posture: 'authoritative', note: null,
  suppress_headline: false, threshold: 30, n: 80, reason: null,
};

test('a HARD-gated below-threshold report WITHHOLDS the headline', () => {
  const m = buildRenderModel(base(GATE_SUPPRESSED));
  expect(m.headline).toBeNull();
  expect(m.gate.withheld).toBe(true);
});

test('the note explains the withholding, so every renderer says why for free', () => {
  const m = buildRenderModel(base(GATE_SUPPRESSED));
  expect(m.gate.note).toContain('withheld');
  expect(m.gate.note).toContain('n=5');
  expect(m.gate.note).toContain('30');
});

test('SOFT-gated reports KEEP the number - only hard gates withhold', () => {
  const m = buildRenderModel(base(GATE_SOFT));
  expect(m.headline).not.toBeNull();
  expect(m.headline.all).toHaveLength(2);
  expect(m.gate.withheld).toBe(false);
  // A soft note must not claim a withholding that did not happen.
  expect(m.gate.note).not.toContain('withheld');
});

test('an authoritative report is completely untouched', () => {
  const m = buildRenderModel(base(GATE_OK));
  expect(m.headline.primary.value).toBe('$42');
  expect(m.gate.withheld).toBe(false);
  expect(m.gate.note).toBeNull();
});

test('withholding the figure does NOT withhold the evidence', () => {
  const m = buildRenderModel(base(GATE_SUPPRESSED));
  expect(m.headline).toBeNull();
  // The supporting material a reader still needs must survive.
  expect(m.keyFindings.length).toBeGreaterThan(0);
  expect(m.personas.length).toBeGreaterThan(0);
});

test('a report with no gate at all keeps its headline (no accidental suppression)', () => {
  const m = buildRenderModel({ title: 'T', headline: HEADLINE, centerpiece: null });
  expect(m.headline).not.toBeNull();
  expect(m.gate).toBeNull();
});
