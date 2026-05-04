// Pass 25 Phase 0.1 Bug B — screener tautology replacement.
// Detects screener questions and (when 100% qualified) replaces the AI
// per-question insight with a sample-composition note.

function isScreener(q) {
  if (!q) return false;
  if (q.type === 'screening') return true;
  if (q.isScreening === true) return true;
  if (typeof q.qualifyingAnswer === 'string' && q.qualifyingAnswer.length > 0) return true;
  if (Array.isArray(q.qualifying_answers) && q.qualifying_answers.length > 0) return true;
  return false;
}

function getSampleCompositionNote(question, aggregation, sampleMetrics) {
  const nQualified = Number(sampleMetrics?.completed ?? aggregation?.n ?? 0);
  const nTotal = Number(sampleMetrics?.total_respondents ?? aggregation?.n_total ?? nQualified);
  const pct = nTotal > 0 ? Math.round((nQualified / nTotal) * 100) : 0;
  const headline = nTotal === nQualified
    ? `Sample profile: ${nQualified} of ${nTotal} respondents qualified (100% qualifying rate).`
    : `Sample profile: ${nQualified} of ${nTotal} respondents qualified (${pct}% qualifying rate).`;
  const criterion = question?.qualifyingAnswer
    ? `Screener filters on: "${question.qualifyingAnswer}".`
    : 'Screener used to filter the sample.';
  return { headline, body: criterion };
}

// Returns the insight to render for this question.
// - For non-screener questions: return original insight unchanged.
// - For screener questions where 100% qualified: replace with composition note (tautology fix).
// - For screener questions where <100% qualified: keep original insight (it's likely useful).
function resolveQuestionInsight(question, aggregation, originalInsight, sampleMetrics) {
  if (!isScreener(question)) return originalInsight;
  const nQ = Number(sampleMetrics?.completed ?? aggregation?.n ?? 0);
  const nT = Number(sampleMetrics?.total_respondents ?? aggregation?.n_total ?? nQ);
  if (nT === 0 || nQ < nT) return originalInsight;
  return getSampleCompositionNote(question, aggregation, sampleMetrics);
}

module.exports = { isScreener, getSampleCompositionNote, resolveQuestionInsight };
