/**
 * Pass 48 — persona_response_reasoning idempotency
 * (src/services/ai/persistResponses.js -> persistReasoningRows).
 *
 * This table shares the (mission_id, persona_id, question_id) natural key with
 * mission_responses and was written from the same in-memory `responses` array
 * by the same runMission completion block, through a second UNCONDITIONAL
 * chunked insert. A re-entered run therefore duplicated it in lockstep
 * (production survey 2026-08-31: 15 duplicate rows on af36a36d, 37 rows / 22
 * distinct keys — the same shape mission_responses shows for that mission).
 *
 * The mock here deliberately TRACKS THE TABLE NAME, which the
 * mission_responses suite does not need to. Both entry points share one
 * generic core, so the failure mode this suite exists to catch is a helper
 * that is correct in every respect except that it writes to the wrong table.
 */

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const {
  persistReasoningRows,
  persistResponseRows,
  loadPersistedReasoningKeys,
  responseKey,
  REASONING_CONFLICT_TARGET,
  RESPONSE_TABLE,
  REASONING_TABLE,
} = require('../src/services/ai/persistResponses');

const MISSION = 'm-1';

/** Table-aware supabase stub: every call records which table it hit. */
function makeSupabase({ existing = [], selectError = null, upsertError = null, insertError = null } = {}) {
  const calls = {
    upserts: [], inserts: [], ranges: [], upsertOpts: [],
    tables: { select: [], upsert: [], insert: [] },
  };
  return {
    calls,
    from(table) {
      const chain = {
        select() { calls.tables.select.push(table); return chain; },
        eq() { return chain; },
        order() { return chain; },
        async range(from, to) {
          calls.ranges.push([from, to]);
          if (selectError) return { data: null, error: selectError };
          return { data: existing.slice(from, to + 1), error: null };
        },
        async upsert(rows, opts) {
          calls.tables.upsert.push(table);
          calls.upsertOpts.push(opts);
          if (upsertError) return { error: upsertError };
          calls.upserts.push(...rows);
          return { error: null };
        },
        async insert(rows) {
          calls.tables.insert.push(table);
          if (insertError) return { error: insertError };
          calls.inserts.push(...rows);
          return { error: null };
        },
      };
      return chain;
    },
  };
}

const row = (pid, qid, why = 'because') => ({
  mission_id: MISSION, persona_id: pid, question_id: qid,
  response_value: 'Al Marai', reasoning_text: why,
});

// ── the copy-paste guard ────────────────────────────────────────────────
test('reads and writes persona_response_reasoning, never mission_responses', async () => {
  const sb = makeSupabase();
  await persistReasoningRows(sb, MISSION, [row('P001', 'q1')]);
  expect(REASONING_TABLE).toBe('persona_response_reasoning');
  expect(sb.calls.tables.select).toEqual([REASONING_TABLE]);
  expect(sb.calls.tables.upsert).toEqual([REASONING_TABLE]);
  expect(sb.calls.tables.select).not.toContain(RESPONSE_TABLE);
  expect(sb.calls.tables.upsert).not.toContain(RESPONSE_TABLE);
});

test('the sibling entry point still targets mission_responses', async () => {
  const sb = makeSupabase();
  await persistResponseRows(sb, MISSION, [{ mission_id: MISSION, persona_id: 'P001', question_id: 'q1', answer: 'a' }]);
  expect(sb.calls.tables.upsert).toEqual([RESPONSE_TABLE]);
  expect(sb.calls.tables.upsert).not.toContain(REASONING_TABLE);
});

// ── idempotency ─────────────────────────────────────────────────────────
test('skips reasoning rows whose (persona_id, question_id) is already stored', async () => {
  const sb = makeSupabase({ existing: [{ persona_id: 'P001', question_id: 'q1' }] });
  const r = await persistReasoningRows(sb, MISSION, [row('P001', 'q1'), row('P001', 'q2')]);
  expect(r.attempted).toBe(2);
  expect(r.skipped).toBe(1);
  expect(r.sent).toBe(1);
  expect(sb.calls.upserts.map((x) => x.question_id)).toEqual(['q2']);
});

test('a second identical run inserts nothing (the af36a36d scenario)', async () => {
  const stored = [];
  for (const p of ['P001', 'P002']) for (const q of ['q1', 'q2']) stored.push({ persona_id: p, question_id: q });
  const sb = makeSupabase({ existing: stored });
  const rows = stored.map((s) => row(s.persona_id, s.question_id, 'a different reason from run 2'));
  const r = await persistReasoningRows(sb, MISSION, rows);
  expect(r.skipped).toBe(4);
  expect(r.sent).toBe(0);
  expect(sb.calls.upserts).toHaveLength(0);
  expect(sb.calls.inserts).toHaveLength(0);
});

test('de-duplicates within a single batch', async () => {
  const sb = makeSupabase();
  const r = await persistReasoningRows(sb, MISSION, [row('P001', 'q1'), row('P001', 'q1')]);
  expect(r.skipped).toBe(1);
  expect(r.sent).toBe(1);
});

test('honours and mutates a caller-supplied knownKeys set', async () => {
  const keys = new Set([responseKey(MISSION, 'P001', 'q1')]);
  const sb = makeSupabase();
  const r = await persistReasoningRows(sb, MISSION, [row('P001', 'q1'), row('P002', 'q1')], { knownKeys: keys });
  expect(r.skipped).toBe(1);
  expect(r.sent).toBe(1);
  expect(sb.calls.ranges).toHaveLength(0); // no DB read when keys are supplied
  expect(keys.has(responseKey(MISSION, 'P002', 'q1'))).toBe(true);
});

// ── the 1000-row cap ────────────────────────────────────────────────────
test('pages the key read past the PostgREST 1000-row cap', async () => {
  const existing = [];
  for (let i = 0; i < 1400; i += 1) existing.push({ persona_id: `P${i}`, question_id: 'q1' });
  const sb = makeSupabase({ existing });
  const { keys, error } = await loadPersistedReasoningKeys(sb, MISSION);
  expect(error).toBeNull();
  expect(keys.size).toBe(1400);
  expect(sb.calls.ranges.length).toBeGreaterThan(1);
  expect(keys.has(responseKey(MISSION, 'P1399', 'q1'))).toBe(true);
});

// ── the write ───────────────────────────────────────────────────────────
test('writes ON CONFLICT DO NOTHING against the reasoning natural key', async () => {
  const sb = makeSupabase();
  await persistReasoningRows(sb, MISSION, [row('P001', 'q1')]);
  expect(sb.calls.upsertOpts[0]).toEqual({
    onConflict: REASONING_CONFLICT_TARGET,
    ignoreDuplicates: true,
  });
  expect(REASONING_CONFLICT_TARGET).toBe('mission_id,persona_id,question_id');
});

test('falls back to a plain insert when the unique index is absent (42P10)', async () => {
  const sb = makeSupabase({ upsertError: { code: '42P10', message: 'no unique or exclusion constraint matching the ON CONFLICT specification' } });
  const r = await persistReasoningRows(sb, MISSION, [row('P001', 'q1')]);
  expect(r.error).toBeNull();
  expect(r.sent).toBe(1);
  expect(sb.calls.tables.insert).toEqual([REASONING_TABLE]);
  expect(sb.calls.inserts).toHaveLength(1);
});

// ── never insert blind ──────────────────────────────────────────────────
test('a failed key read surfaces the error and never degrades to a blind insert', async () => {
  const sb = makeSupabase({ selectError: { message: 'connection reset' } });
  const r = await persistReasoningRows(sb, MISSION, [row('P001', 'q1')]);
  expect(r.error).toBeTruthy();
  expect(r.sent).toBe(0);
  expect(sb.calls.upserts).toHaveLength(0);
  expect(sb.calls.inserts).toHaveLength(0);
});

test('an empty batch is a no-op and touches no table', async () => {
  const sb = makeSupabase();
  const r = await persistReasoningRows(sb, MISSION, []);
  expect(r).toEqual({ attempted: 0, skipped: 0, sent: 0, error: null });
  expect(sb.calls.tables.select).toHaveLength(0);
});
