/**
 * What a Creative Attention run was measured against, in the words every
 * export uses.
 *
 * The PDF, the PPTX and the XLSX all show the placement and market. Each used
 * to format its own figures, which is how exports end up disagreeing about the
 * same number. They all call this instead, so the sentence a customer reads is
 * worded once.
 *
 * Reads only what the analysis stored (creative_analysis.placement_benchmark,
 * .market, .market_context) - the placement and market this run's numbers
 * belong to - never the live mission columns, which could be edited after the
 * run. Returns null for analyses that predate placement and market, so older
 * reports render exactly as before.
 *
 * House style: hyphens, never em or en dashes.
 */
'use strict';

const NOTE_SECTIONS = [
  ['cultural_fit', 'Cultural fit'],
  ['localisation_risks', 'Localisation risks'],
  ['placement_notes', 'How the placement is used there'],
];

const fmtSeconds = (n) => `${Number(n).toFixed(1)}s`;

function placementSentence(pb) {
  const norm = fmtSeconds(pb.norm_active_seconds);
  if (pb.predicted_active_seconds == null || pb.delta_vs_norm_pct == null) {
    return `The published attention norm for ${pb.placement_label} is ${norm} of active attention. This run returned no attention prediction to compare against it.`;
  }
  const predicted = fmtSeconds(pb.predicted_active_seconds);
  const d = pb.delta_vs_norm_pct;
  if (d === 0) {
    return `Predicted ${predicted} of active attention on ${pb.placement_label}, in line with the published norm of ${norm}.`;
  }
  const direction = d > 0 ? 'above' : 'below';
  return `Predicted ${predicted} of active attention on ${pb.placement_label}, ${Math.abs(d)}% ${direction} the published norm of ${norm}.`;
}

function caTargetingView(creativeAnalysis) {
  const ca = creativeAnalysis && typeof creativeAnalysis === 'object' ? creativeAnalysis : {};
  const pb = ca.placement_benchmark && typeof ca.placement_benchmark === 'object' ? ca.placement_benchmark : null;
  const market = ca.market && typeof ca.market === 'object' && ca.market.name ? ca.market : null;
  if (!pb && !market) return null;

  const ctx = ca.market_context && typeof ca.market_context === 'object' ? ca.market_context : null;
  const noteSections = ctx
    ? NOTE_SECTIONS
      .map(([key, heading]) => ({ key, heading, items: (Array.isArray(ctx[key]) ? ctx[key] : []).filter((s) => typeof s === 'string' && s) }))
      .filter((s) => s.items.length > 0)
    : [];

  return {
    placement: pb ? {
      id: pb.placement_id,
      label: pb.placement_label,
      normSeconds: pb.norm_active_seconds,
      predictedSeconds: pb.predicted_active_seconds,
      deltaPct: pb.delta_vs_norm_pct,
      normLabel: fmtSeconds(pb.norm_active_seconds),
      predictedLabel: pb.predicted_active_seconds == null ? 'Not predicted' : fmtSeconds(pb.predicted_active_seconds),
      // Short enough to sit on one line in a stat card; the card's own label
      // ("Versus norm") carries the rest.
      deltaLabel: pb.delta_vs_norm_pct == null
        ? 'Not compared'
        : (pb.delta_vs_norm_pct === 0 ? 'In line' : `${pb.delta_vs_norm_pct > 0 ? '+' : '-'}${Math.abs(pb.delta_vs_norm_pct)}%`),
      sentence: placementSentence(pb),
    } : null,
    market: market ? { code: market.code, name: market.name } : null,
    marketNoteSections: noteSections,
    marketNotesUnavailable: !!market && noteSections.length === 0,
    // one line for a cover or title slide
    summaryLine: [
      pb ? `Placement: ${pb.placement_label}` : null,
      market ? `Market: ${market.name}` : null,
    ].filter(Boolean).join('  |  '),
  };
}

module.exports = { caTargetingView, placementSentence };
