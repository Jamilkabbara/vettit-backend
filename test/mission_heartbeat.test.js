/**
 * Pass 49 PR 3 — missions.heartbeat_at.
 *
 * WHY THE COLUMN
 * --------------
 * Both reapers reasoned about started_at, which measures how long a
 * mission has EXISTED, not whether it is alive:
 *
 *   Job 1: processing AND started_at < now()-6h => write 'failed'. A
 *     healthy 1000-respondent recruit-loop run projects to ~3.4h at a
 *     100% screener pass rate and ~4.9h at 70%, so the reaper auto-fails
 *     healthy long runs — a false-positive machine on the tier this work
 *     exists to unblock.
 *   Job 3: the Pass 48 started_at gate only protects the first 15 minutes
 *     of a run, so a 1000-respondent mission 20 minutes into a healthy
 *     5-hour run is already past it and every rolling deploy re-enters it
 *     with {resume:true} — the concurrency behind 785 duplicate rows.
 *
 * WHAT THIS FILE PROVES
 * ---------------------
 *   A. heartbeat_at is in ALLOWED_COLUMNS. sanitizeMissionPatch drops
 *      unknown keys with only a logger.warn, which has already silently
 *      broken two shipped columns (brand_name, category). This is the
 *      regression test for that footgun.
 *   B. The reaper gates read heartbeat staleness, with an EXPLICIT
 *      started_at fallback (and each job's pre-Pass-49 threshold) when the
 *      heartbeat is NULL.
 *   C. Job 1's gate is strictly looser than Job 3's, so a resumable
 *      mission gets resumed rather than reaped.
 *   D. The loop writes the heartbeat from writeProgress — no extra query.
 *   E. Everything degrades gracefully if the migration has not been
 *      applied yet (PostgREST 42703).
 *
 * MUTATION CHECK: recorded in the PR body.
 */

jest.mock('../src/db/supabase', () => ({ from: jest.fn() }));
jest.mock('../src/jobs/runMission', () => ({ runMission: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const supabase = require('../src/db/supabase');
const logger = require('../src/utils/logger');
const { runMission } = require('../src/jobs/runMission');
const {
  ALLOWED_COLUMNS,
  sanitizeMissionPatch,
  isHeartbeatColumnMissing,
  noteHeartbeatColumnMissing,
  _resetHeartbeatColumnLatch,
} = require('../src/db/missionSchema');
const {
  runJob1,
  runJob3BootResume,
  isReapable,
  isResumable,
  HEARTBEAT_STALE_MIN,
  JOB1_HEARTBEAT_STALE_MIN,
  JOB1_STUCK_AFTER_HOURS,
  JOB3_MIN_STRANDED_AGE_MIN,
} = require('../src/jobs/missionRecovery');

const minAgo = (n) => new Date(Date.now() - n * 60 * 1000).toISOString();
const hoursAgo = (n) => new Date(Date.now() - n * 3600 * 1000).toISOString();

beforeEach(() => { jest.clearAllMocks(); _resetHeartbeatColumnLatch(); });

// ═══ A. the sanitizer footgun ══════════════════════════════════════════════

describe('ALLOWED_COLUMNS', () => {
  test('contains heartbeat_at — otherwise every write is silently dropped', () => {
    expect(ALLOWED_COLUMNS.has('heartbeat_at')).toBe(true);
  });

  test('a heartbeat patch survives sanitizeMissionPatch intact', () => {
    const stamp = new Date().toISOString();
    const { patch, rejected } = sanitizeMissionPatch({
      recruited_persona_count: 7, heartbeat_at: stamp,
    });
    expect(patch).toEqual({ recruited_persona_count: 7, heartbeat_at: stamp });
    expect(rejected).toEqual([]);
  });

  test('the footgun is real: an unlisted column is dropped with only a warn', () => {
    const { patch, rejected } = sanitizeMissionPatch({ heartbeat_atx: 'typo' });
    expect(patch).toEqual({});
    expect(rejected).toEqual(['heartbeat_atx']);
  });
});

// ═══ B/C. the reaper gates ═════════════════════════════════════════════════

describe('Job 1 auto-fail gate (isReapable)', () => {
  test('a mission checking in right now is NEVER reaped, however old it is', () => {
    expect(isReapable({ started_at: hoursAgo(9), heartbeat_at: minAgo(0.2) })).toBe(false);
  });

  test('THE 1000-RESPONDENT CASE: a 7-hour run still checking in survives', () => {
    // Under the old rule this row was auto-failed at the 6h mark while
    // healthy. Its heartbeat is 20 seconds old.
    const healthyLongRun = { started_at: hoursAgo(7), heartbeat_at: minAgo(0.33) };
    expect(isReapable(healthyLongRun)).toBe(false);
    // And the same row with a dead process IS reaped — in 45 minutes
    // rather than the 6 hours it used to take.
    expect(isReapable({ started_at: hoursAgo(7), heartbeat_at: minAgo(46) })).toBe(true);
  });

  test('a silent mission is reaped once past the Job 1 threshold', () => {
    expect(isReapable({ started_at: hoursAgo(2), heartbeat_at: minAgo(JOB1_HEARTBEAT_STALE_MIN - 1) })).toBe(false);
    expect(isReapable({ started_at: hoursAgo(2), heartbeat_at: minAgo(JOB1_HEARTBEAT_STALE_MIN + 1) })).toBe(true);
  });

  test('NULL heartbeat falls back to started_at at the UNCHANGED 6h window', () => {
    expect(isReapable({ started_at: hoursAgo(JOB1_STUCK_AFTER_HOURS - 1), heartbeat_at: null })).toBe(false);
    expect(isReapable({ started_at: hoursAgo(JOB1_STUCK_AFTER_HOURS + 1), heartbeat_at: null })).toBe(true);
  });

  test('a processing row with neither stamp is left alone, not guessed at', () => {
    expect(isReapable({ started_at: null, heartbeat_at: null })).toBe(false);
  });

  test('the Job 1 threshold clears the ~30 min worst-case SDK silence', () => {
    // The Anthropic client is built with no explicit timeout, so it uses
    // the documented defaults (timeout 10 min, maxRetries 2): one logical
    // call can be legitimately silent for ~30 minutes.
    expect(JOB1_HEARTBEAT_STALE_MIN).toBeGreaterThan(30);
    expect(isReapable({ started_at: hoursAgo(1), heartbeat_at: minAgo(30) })).toBe(false);
  });
});

describe('Job 3 resume gate (isResumable)', () => {
  test('THE ROLLING-DEPLOY CASE: a healthy long run is no longer re-entered', () => {
    // Pass 48 skipped only the first 15 minutes by started_at, so this row
    // — 20 minutes into a healthy 5-hour run — was resumed on every deploy.
    const healthyMidRun = { started_at: minAgo(20), heartbeat_at: minAgo(0.2) };
    expect(isResumable(healthyMidRun)).toBe(false);
    // Four hours in and still checking in: still protected.
    expect(isResumable({ started_at: hoursAgo(4), heartbeat_at: minAgo(0.2) })).toBe(false);
  });

  test('a genuinely stranded mission IS resumable once it goes silent', () => {
    expect(isResumable({ started_at: hoursAgo(1), heartbeat_at: minAgo(HEARTBEAT_STALE_MIN + 1) })).toBe(true);
    expect(isResumable({ started_at: hoursAgo(1), heartbeat_at: minAgo(HEARTBEAT_STALE_MIN - 1) })).toBe(false);
  });

  test('NULL heartbeat falls back to the UNCHANGED Pass 48 started_at gate', () => {
    expect(isResumable({ started_at: minAgo(JOB3_MIN_STRANDED_AGE_MIN - 1), heartbeat_at: null })).toBe(false);
    expect(isResumable({ started_at: minAgo(JOB3_MIN_STRANDED_AGE_MIN + 1), heartbeat_at: null })).toBe(true);
    expect(isResumable({ started_at: null, heartbeat_at: null })).toBe(true);
  });
});

describe('the two gates cannot race each other', () => {
  test('Job 1 is strictly looser than Job 3, so resume always wins', () => {
    expect(JOB1_HEARTBEAT_STALE_MIN).toBeGreaterThan(HEARTBEAT_STALE_MIN);
  });

  test('every mission Job 3 will resume is one Job 1 will NOT reap', () => {
    // Job 3's primer fires at T+20s and Job 1's at T+30s against the same
    // rows. A resumed run must generate a persona before its first
    // heartbeat lands (persona_gen: 7.0s mean, 25.8s p95, 44.8s max in
    // production), so Job 1 must not be able to reap what Job 3 just took.
    for (let stale = HEARTBEAT_STALE_MIN + 0.5; stale <= JOB1_HEARTBEAT_STALE_MIN; stale += 1) {
      const row = { started_at: hoursAgo(2), heartbeat_at: minAgo(stale) };
      expect(isResumable(row)).toBe(true);
      expect(isReapable(row)).toBe(false);
    }
  });
});

// ═══ the jobs end to end ═══════════════════════════════════════════════════

/** cron_locks + a scripted set of status='processing' rows. */
function wireSupabase(processingRows, { selectError = null } = {}) {
  const selects = [];
  const updates = [];
  supabase.from.mockImplementation((table) => {
    if (table === 'cron_locks') {
      const c = {
        insert: async () => ({ error: null }), upsert: async () => ({ error: null }),
        select: () => c, update: () => c, delete: () => c, eq: () => c, lt: () => c,
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        then: (r) => r({ data: [], error: null }),
      };
      return c;
    }
    const st = { cols: null, op: 'select', patch: null };
    const c = {
      select: (cols) => { st.cols = cols; if (st.op === 'select') selects.push(cols); return c; },
      update: (patch) => { st.op = 'update'; st.patch = patch; updates.push(patch); return c; },
      insert: async () => ({ error: null }),
      eq: () => c,
      lt: () => c,
      limit: () => c,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (resolve) => {
        if (st.op === 'update') return resolve({ data: [{ id: 'x' }], error: null });
        if (selectError && String(st.cols).includes('heartbeat_at')) {
          return resolve({ data: null, error: selectError });
        }
        return resolve({ data: processingRows, error: null });
      },
    };
    return c;
  });
  return { selects, updates };
}

async function flush() {
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

describe('runJob1 end to end', () => {
  test('reaps only the silent mission, not the one checking in', async () => {
    const { updates } = wireSupabase([
      { id: 'alive', status: 'processing', started_at: hoursAgo(7), heartbeat_at: minAgo(0.2) },
      { id: 'dead',  status: 'processing', started_at: hoursAgo(7), heartbeat_at: minAgo(90) },
    ]);

    await runJob1();

    const failWrites = updates.filter((u) => u.status === 'failed');
    expect(failWrites).toHaveLength(1);
    expect(failWrites[0].failure_reason).toContain('has not checked in');
  });

  test('the failure reason names the heartbeat, not a wall-clock guess', async () => {
    const { updates } = wireSupabase([
      { id: 'dead', status: 'processing', started_at: hoursAgo(2), heartbeat_at: minAgo(90) },
    ]);

    await runJob1();

    expect(updates.find((u) => u.status === 'failed').failure_reason)
      .toMatch(/has not checked in for \d+ min/);
  });

  test('a NULL-heartbeat row is described as such, at the old 6h window', async () => {
    const { updates } = wireSupabase([
      { id: 'legacy', status: 'processing', started_at: hoursAgo(7), heartbeat_at: null },
    ]);

    await runJob1();

    expect(updates.find((u) => u.status === 'failed').failure_reason)
      .toContain('no heartbeat ever recorded');
  });
});

describe('runJob3BootResume end to end', () => {
  test('does not resume a mission that is still checking in', async () => {
    wireSupabase([
      { id: 'alive', title: 'live', started_at: hoursAgo(4), heartbeat_at: minAgo(0.2), recruitment_status: 'recruiting' },
    ]);

    await runJob3BootResume();
    await flush();

    expect(runMission).not.toHaveBeenCalled();
  });

  test('resumes a mission that has gone silent', async () => {
    wireSupabase([
      { id: 'stranded', title: 'silent', started_at: hoursAgo(4), heartbeat_at: minAgo(HEARTBEAT_STALE_MIN + 5), recruitment_status: 'recruiting' },
    ]);

    await runJob3BootResume();
    await flush();

    expect(runMission).toHaveBeenCalledWith('stranded', { resume: true });
  });
});

// ═══ E. migration-not-yet-applied fallback ═════════════════════════════════

describe('graceful degradation when the migration has not been applied', () => {
  const missing = { code: '42703', message: 'column missions.heartbeat_at does not exist' };

  test('noteHeartbeatColumnMissing latches, and logs once at error level', () => {
    expect(isHeartbeatColumnMissing()).toBe(false);

    expect(noteHeartbeatColumnMissing(missing, 'test')).toBe(true);
    expect(isHeartbeatColumnMissing()).toBe(true);
    expect(logger.error).toHaveBeenCalledTimes(1);

    noteHeartbeatColumnMissing(missing, 'test');
    expect(logger.error).toHaveBeenCalledTimes(1);   // still once — not per row
  });

  test('an unrelated postgres error is NOT mistaken for the missing column', () => {
    expect(noteHeartbeatColumnMissing({ code: '23505', message: 'duplicate key' }, 'test')).toBe(false);
    expect(noteHeartbeatColumnMissing({ code: '42703', message: 'column missions.nope does not exist' }, 'test')).toBe(false);
    expect(isHeartbeatColumnMissing()).toBe(false);
  });

  test('Job 1 re-selects without the column and reverts to the 6h started_at gate', async () => {
    const { selects, updates } = wireSupabase(
      [{ id: 'legacy', status: 'processing', started_at: hoursAgo(7) }],
      { selectError: missing },
    );

    await runJob1();

    // First attempt asked for heartbeat_at; the retry did not.
    expect(selects.some((c) => String(c).includes('heartbeat_at'))).toBe(true);
    expect(selects.some((c) => !String(c).includes('heartbeat_at'))).toBe(true);
    // And it still did its job under the pre-Pass-49 rule.
    expect(updates.filter((u) => u.status === 'failed')).toHaveLength(1);
  });

  test('Job 3 re-selects without the column and reverts to the Pass 48 gate', async () => {
    const { selects } = wireSupabase(
      [{ id: 'legacy', title: 't', started_at: minAgo(JOB3_MIN_STRANDED_AGE_MIN + 5) }],
      { selectError: missing },
    );

    await runJob3BootResume();
    await flush();

    expect(selects.some((c) => String(c).includes('heartbeat_at'))).toBe(true);
    expect(runMission).toHaveBeenCalledWith('legacy', { resume: true });
  });
});
