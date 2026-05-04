// Pass 25 Phase 0.1 Minor 1 — single shared util for date semantics.
// Distinguishes "Mission completed" (data freshness) from "Report generated"
// (document freshness). Used by every export format's cover/header.

function fmt(date) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function getReportMetadata(mission) {
  const completed = fmt(mission?.completed_at);
  const generated = fmt(new Date());
  return {
    mission_completed_at: mission?.completed_at || null,
    mission_completed_label: completed || '—',
    report_generated_at: new Date().toISOString(),
    report_generated_label: generated || '—',
  };
}

module.exports = { getReportMetadata };
