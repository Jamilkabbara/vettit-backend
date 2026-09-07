/**
 * failure_reason must never carry an em dash or an en dash.
 *
 * WHY THIS COLUMN IS DIFFERENT. Every other user-facing surface in this
 * codebase already routes through sanitizeDashesString: the exports, the
 * chatbot, buildReport, reportRenderModel, segments. failure_reason did not,
 * and it is the one string the customer reads that NOTHING between the
 * database and the screen can clean, because ProcessingPage.tsx reads the
 * column straight out of Postgres with supabase-js. There is no server render
 * step to scrub it.
 *
 * The live evidence: production mission a8f878bc holds
 *   "Mission has not checked in for 50 min (>45 min heartbeat threshold) —
 *    auto-failed by recovery cron"
 * written by the heartbeat reaper, em dash and all. Every future auto-fail
 * would have carried one.
 *
 * Sanitizing at the WRITE, not the read, for the same reason the truncation
 * already happens at the write: the read side is a direct table read this
 * codebase does not control.
 */
const { sanitizeDashesString } = require('../src/utils/textSanitize');

const DASHES = /[–—]/;

describe('failure_reason is written without dashes', () => {
  test('the heartbeat reaper message is clean at the source', () => {
    // The literal as it now stands in missionRecovery.js reapReason().
    const msg = `Mission has not checked in for 50 min (>45 min heartbeat threshold), auto-failed by recovery cron`;
    expect(msg).not.toMatch(DASHES);
  });

  test('the no-heartbeat-ever message is clean at the source', () => {
    const msg = `Mission stuck in 'processing' for >6h with no heartbeat ever recorded, auto-failed by recovery cron`;
    expect(msg).not.toMatch(DASHES);
  });

  test('the sanitizer catches a dash that reaches it from upstream', () => {
    // The generic branch of friendlyFailureReason passes raw vendor text
    // through, so the guarantee has to be the sanitizer, not the literals.
    const upstream = 'The model returned an error — the request was malformed';
    const out = sanitizeDashesString(upstream);
    expect(out).not.toMatch(DASHES);
    expect(out).toBe('The model returned an error, the request was malformed');
  });

  test('en dashes become hyphens, so numeric ranges still read correctly', () => {
    expect(sanitizeDashesString('SAR 31–40')).toBe('SAR 31-40');
  });

  test('a trailing dash does not leave an orphan comma', () => {
    expect(sanitizeDashesString('the run stopped —')).toBe('the run stopped');
  });

  test('the sanitizer is idempotent and null-safe', () => {
    const once = sanitizeDashesString('a — b');
    expect(sanitizeDashesString(once)).toBe(once);
    expect(sanitizeDashesString(null)).toBeNull();
    expect(sanitizeDashesString(undefined)).toBeUndefined();
  });

  test('a clean string is returned unchanged', () => {
    const s = 'The uploaded image format was not accepted by our analysis engine.';
    expect(sanitizeDashesString(s)).toBe(s);
  });
});
