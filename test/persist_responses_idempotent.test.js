/**
 * Pass 48 — src/services/ai/persistResponses.js
 *
 * The unit that makes mission_responses writes idempotent. Covers:
 *   - the skip-set (never re-send a stored (persona_id, question_id))
 *   - within-batch de-duplication
 *   - the key read is PAGED (an unbounded select caps at 1000 and would
 *     make the skip-set lie for any mission past 1000 rows)
 *   - ON CONFLICT DO NOTHING is the write, with a plain-insert fallback
 *     when the unique index has not been applied yet (42P10)
 *   - a failed key read NEVER degrades into a blind insert
 */

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const {
  persistResponseRows,
  loadPersistedResponseKeys,
  responseKey,
  RESPONSE_CONFLICT_TARGET,
} = require('../src/services/ai/persistResponses');

const MISSION = 'm-1';

/**
 * Supabase stub for mission_responses.
 *  existing   — rows already "stored" (persona_id/question_id pairs)
 *  upsertError/insertError — injected failures
 */
function makeSupabase({ existing = [], selectError = null, upsertError = null, insertError = null } = {}) {
  const calls = { upserts: [], inserts: [], ranges: [], upsertOpts: [] };
  return {
    calls,
    from() {
      const chain = {
        _range: null,
        select() { return chain; },
        eq() { return chain; },
        order() { return chain; },
        async range(from, to) {
          calls.ranges.push([from, to]);
          if (selectError) return { data: null, error: selectError };
          return { data: existing.slice(from, to + 1), error: null };
        },
        async upsert(rows, opts) {
          calls.upsertOpts.push(opts);
          if (upsertError) return { error: upsertError };
          calls.upserts.push(...rows);
          return { error: null };
        },
        async insert(rows) {
          if (insertError) return { error: insertError };
          calls.inserts.push(...rows);
          return { error: null };
        },
      };
      return chain;
    },
  };
}

const row = (pid, qid) => ({
  mission_id: MISSION, persona_id: pid, question_id: qid, answer: 'a', screened_out: false,
});

test('skips rows whose (persona_id, question_id) is already stored', async () => {
  const sb = makeSupabase({ existing: [{ persona_id: 'P001', question_id: 'q1' }] });

  const r = await persistResponseRows(sb, MISSION, [row('P001', 'q1'), row('P001', 'q2')]);

  expect(r.skipped).toBe(1);
  expect(r.sent).toBe(1);
  expect(r.error).toBeNull();
  expect(sb.calls.upserts).toHaveLength(1);
  expect(sb.calls.upserts[0].question_id).toBe('q2');
});

test('a fully-duplicate batch writes NOTHING (the resume/concurrent-run case)', async () => {
  const existing = [
    { persona_id: 'P001', question_id: 'q1' },
    { persona_id: 'P001', question_id: 'q2' },
  ];
  const sb = makeSupabase({ existing });

  const r = await persistResponseRows(sb, MISSION, [row('P001', 'q1'), row('P001', 'q2')]);

  expect(r).toMatchObject({ attempted: 2, skipped: 2, sent: 0, error: null });
  expect(sb.calls.upserts).toHaveLength(0);
  expect(sb.calls.inserts).toHaveLength(0);
});

test('de-duplicates within a single batch', async () => {
  const sb = makeSupabase();
  const r = await persistResponseRows(sb, MISSION, [row('P001', 'q1'), row('P001', 'q1')]);
  expect(r.skipped).toBe(1);
  expect(sb.calls.upserts).toHaveLength(1);
});

test('a supplied knownKeys set is used instead of a read, and is mutated', async () => {
  const sb = makeSupabase({ existing: [{ persona_id: 'P009', question_id: 'q9' }] });
  const keys = new Set([responseKey(MISSION, 'P001', 'q1')]);

  const r = await persistResponseRows(sb, MISSION, [row('P001', 'q1'), row('P002', 'q1')], { knownKeys: keys });

  expect(sb.calls.ranges).toHaveLength(0); // no DB read at all
  expect(r.skipped).toBe(1);
  expect(keys.has(responseKey(MISSION, 'P002', 'q1'))).toBe(true);
});

test('key read is paged — a mission with >1000 rows is fully covered', async () => {
  const existing = [];
  for (let i = 0; i < 1500; i += 1) existing.push({ persona_id: `P${i}`, question_id: 'q1' });
  const sb = makeSupabase({ existing });

  const { keys, error } = await loadPersistedResponseKeys(sb, MISSION);

  expect(error).toBeNull();
  expect(keys.size).toBe(1500);
  expect(sb.calls.ranges).toEqual([[0, 999], [1000, 1999]]);
  // the row past the 1000-row PostgREST cap is genuinely known
  expect(keys.has(responseKey(MISSION, 'P1400', 'q1'))).toBe(true);
});

test('writes via ON CONFLICT DO NOTHING on the natural key', async () => {
  const sb = makeSupabase();
  await persistResponseRows(sb, MISSION, [row('P001', 'q1')]);
  expect(sb.calls.upsertOpts[0]).toEqual({
    onConflict: RESPONSE_CONFLICT_TARGET,
    ignoreDuplicates: true,
  });
  expect(RESPONSE_CONFLICT_TARGET).toBe('mission_id,persona_id,question_id');
});

test('falls back to a plain insert when the unique index is not applied yet (42P10)', async () => {
  const sb = makeSupabase({
    upsertError: { code: '42P10', message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification' },
  });

  const r = await persistResponseRows(sb, MISSION, [row('P001', 'q1')]);

  expect(r.error).toBeNull();
  expect(sb.calls.upserts).toHaveLength(0);
  expect(sb.calls.inserts).toHaveLength(1);
});

test('a failed key read is surfaced and NOTHING is inserted blind', async () => {
  const sb = makeSupabase({ selectError: { message: 'connection reset' } });

  const r = await persistResponseRows(sb, MISSION, [row('P001', 'q1')]);

  expect(r.error).toBeTruthy();
  expect(r.sent).toBe(0);
  expect(sb.calls.upserts).toHaveLength(0);
  expect(sb.calls.inserts).toHaveLength(0);
});

test('a real write error is returned (not swallowed)', async () => {
  const sb = makeSupabase({ upsertError: { code: '23502', message: 'null value in column "answer"' } });
  const r = await persistResponseRows(sb, MISSION, [row('P001', 'q1')]);
  expect(r.error.code).toBe('23502');
});

test('empty input is a no-op', async () => {
  const sb = makeSupabase();
  const r = await persistResponseRows(sb, MISSION, []);
  expect(r).toEqual({ attempted: 0, skipped: 0, sent: 0, error: null });
  expect(sb.calls.ranges).toHaveLength(0);
});
