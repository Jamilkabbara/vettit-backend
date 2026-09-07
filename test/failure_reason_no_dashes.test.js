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

const { readFileSync } = require('node:fs');
const { join } = require('node:path');


/**
 * Read the ACTUAL source, not a copy of it.
 *
 * The first version of this file asserted against string literals typed into
 * the test. Putting the em dash back into missionRecovery.js did not fail it,
 * because the test was never looking at that file. A test that restates the
 * source instead of reading it is a test of the person who wrote it.
 */
const sourceOf = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');

/** String and template literals in a file, excluding // and * comment lines. */
function literalsIn(src) {
  return src
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .join('\n')
    .match(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g) || [];
}

describe('failure_reason is written without dashes', () => {
  test('no reaper message in missionRecovery.js carries a dash', () => {
    // Scoped to reapReason() itself, the function whose return value BECOMES
    // the column. A first version scanned the whole file and flagged a
    // logger.error string, which is a developer log, not customer copy. The
    // rule is about what the customer reads, so the test has to be about the
    // same thing.
    const src = sourceOf('src/jobs/missionRecovery.js');
    const start = src.indexOf('function reapReason');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}', start));
    const offenders = literalsIn(body).filter((lit) => DASHES.test(lit));
    expect(offenders).toEqual([]);
  });

  test('every failure_reason write site routes through the sanitizer', () => {
    // Source-level, because the alternative is asserting a copy of the code.
    const recovery = sourceOf('src/jobs/missionRecovery.js');
    const run      = sourceOf('src/jobs/runMission.js');
    expect(recovery).toMatch(/failure_reason:\s*sanitizeDashesString\(/);
    expect(run).toMatch(/failureReasonForColumn|failure_reason:\s*sanitizeDashesString\(/);
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
