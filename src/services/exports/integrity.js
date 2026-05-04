// Pass 25 Phase 0.1 Bug H + Bug A — read-time integrity checks for the export pipeline.
// Detects schema drift (response keys not in question.options) and pairwise option overlap.
// Returns warnings; never blocks an export.

function detectSchemaDrift(mission, aggregatedByQuestion) {
  const warnings = [];
  const questions = mission?.questions || [];
  for (let idx = 0; idx < questions.length; idx++) {
    const q = questions[idx];
    if (!q || !q.id) continue;
    if (q.type !== 'single' && q.type !== 'multi' && q.type !== 'opinion') continue;
    const schemaOpts = Array.isArray(q.options) ? q.options.map(String) : [];
    const schemaSet = new Set(schemaOpts);
    if (schemaSet.size === 0) continue;
    const dist = aggregatedByQuestion?.[q.id]?.distribution || {};
    const drifted = Object.keys(dist).filter(k => !schemaSet.has(String(k)));
    if (drifted.length > 0) {
      warnings.push({
        type: 'unknown_distribution_key',
        question_id: q.id,
        question_label: `${idx + 1}`,
        question_text: q.text,
        drifted_keys: drifted,
        schema_options: schemaOpts,
      });
    }
  }
  return warnings;
}

// Substring overlap ratio: longest common substring / shorter length.
// Cheap and good enough for "Rewarded video ads" vs "Interstitial and rewarded video ads".
function substringOverlap(a, b) {
  const sa = String(a || '').toLowerCase();
  const sb = String(b || '').toLowerCase();
  if (!sa || !sb) return 0;
  const [shorter, longer] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  for (let len = shorter.length; len >= 4; len--) {
    for (let i = 0; i + len <= shorter.length; i++) {
      if (longer.includes(shorter.slice(i, i + len))) return len / shorter.length;
    }
  }
  return 0;
}

function detectOptionOverlap(mission, threshold = 0.6) {
  const warnings = [];
  const questions = mission?.questions || [];
  for (let idx = 0; idx < questions.length; idx++) {
    const q = questions[idx];
    if (!q || !Array.isArray(q.options) || q.options.length < 2) continue;
    const opts = q.options.map(String);
    for (let i = 0; i < opts.length; i++) {
      for (let j = i + 1; j < opts.length; j++) {
        const ratio = substringOverlap(opts[i], opts[j]);
        if (ratio >= threshold) {
          warnings.push({
            type: 'semantic_option_overlap',
            question_id: q.id,
            question_label: `${idx + 1}`,
            question_text: q.text,
            option_a: opts[i],
            option_b: opts[j],
            overlap_ratio: Math.round(ratio * 100) / 100,
          });
        }
      }
    }
  }
  return warnings;
}

function buildIntegrityWarnings(mission, aggregatedByQuestion) {
  return [
    ...detectSchemaDrift(mission, aggregatedByQuestion),
    ...detectOptionOverlap(mission),
  ];
}

module.exports = {
  detectSchemaDrift,
  detectOptionOverlap,
  buildIntegrityWarnings,
  substringOverlap,
};
