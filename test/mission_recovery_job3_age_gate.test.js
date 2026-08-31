/**
 * Pass 48 — missionRecovery Job 3 must not re-enter a mission that is
 * still running.
 *
 * Job 3 fires 20s after boot and selected EVERY mission in
 * status='processing' with no age gate. On a rolling deploy the new pod
 * boots while a mission that started seconds earlier is mid-flight on the
 * draining pod, so Job 3 re-entered it with {resume:true} — which
 * deliberately bypasses runMission's idempotency claim. Two concurrent
 * generate+simulate runs then each inserted a complete copy of the
 * dataset (production: mission bdae4d45, 1440 rows over 720 keys, the two
 * bulk inserts 3.1s apart at the end of a ~2.7min simulation that a
 * sequential re-run could not have fitted into that gap).
 */

jest.mock('../src/db/supabase', () => ({ from: jest.fn() }));
jest.mock('../src/jobs/runMission', () => ({ runMission: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/db/missionSchema', () => ({
  updateMission: jest.fn().mockResolvedValue({}),
  sanitizeMissionPatch: jest.fn((p) => ({ patch: p, rejected: [] })),
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const supabase = require('../src/db/supabase');
const { runMission } = require('../src/jobs/runMission');
const { runJob3BootResume, JOB3_MIN_STRANDED_AGE_MIN } = require('../src/jobs/missionRecovery');

const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000).toISOString();

/** cron_locks acquire/release + the missions select Job 3 performs. */
function wireSupabase(strandedMissions) {
  supabase.from.mockImplementation((table) => {
    if (table === 'cron_locks') {
      const chain = {
        insert: async () => ({ error: null }),
        upsert: async () => ({ error: null }),
        select: () => chain,
        update: () => chain,
        delete: () => chain,
        eq: () => chain,
        lt: () => chain,
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        then: (resolve) => resolve({ data: [], error: null }),
      };
      return chain;
    }
    const chain = {
      select: () => chain,
      eq: () => chain,
      update: () => chain,
      then: (resolve) => resolve({ data: strandedMissions, error: null }),
    };
    return chain;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
});
afterEach(() => { jest.useRealTimers(); });

async function flush() {
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

test('a mission that started seconds ago is NOT resumed', async () => {
  wireSupabase([{ id: 'live-mission', title: 'running now', started_at: minutesAgo(0.1), recruitment_status: 'recruiting' }]);

  await runJob3BootResume();
  await flush();

  expect(runMission).not.toHaveBeenCalled();
});

test('a genuinely stranded mission IS resumed', async () => {
  wireSupabase([{ id: 'stranded-mission', title: 'stranded', started_at: minutesAgo(JOB3_MIN_STRANDED_AGE_MIN + 30), recruitment_status: 'recruiting' }]);

  await runJob3BootResume();
  await flush();

  expect(runMission).toHaveBeenCalledTimes(1);
  expect(runMission).toHaveBeenCalledWith('stranded-mission', { resume: true });
});

test('a processing row with no started_at is treated as stranded', async () => {
  wireSupabase([{ id: 'no-stamp', title: 'no started_at', started_at: null, recruitment_status: 'pending' }]);

  await runJob3BootResume();
  await flush();

  expect(runMission).toHaveBeenCalledWith('no-stamp', { resume: true });
});

test('mixed batch: only the aged mission is resumed', async () => {
  wireSupabase([
    { id: 'young', title: 'young', started_at: minutesAgo(1), recruitment_status: 'recruiting' },
    { id: 'old', title: 'old', started_at: minutesAgo(JOB3_MIN_STRANDED_AGE_MIN + 5), recruitment_status: 'recruiting' },
  ]);

  await runJob3BootResume();
  await flush();

  expect(runMission).toHaveBeenCalledTimes(1);
  expect(runMission).toHaveBeenCalledWith('old', { resume: true });
});
