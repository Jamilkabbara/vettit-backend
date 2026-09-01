/**
 * Pass 49 — persona id collision in the LEGACY BATCH path
 * (src/services/ai/personas.js -> generatePersonas).
 *
 * Persona ids are ASSIGNED BY THE MODEL: the prompt asks for ids "sequential
 * starting from P<startIndex+1>" and shows "id": "P001" in its example, so a
 * batch can ignore the offset and re-emit an id another batch already
 * produced. The 5 batches of a wave run in parallel and cannot see each
 * other's output, and generatePersonas used to `push(...batch)` with no
 * de-duplication.
 *
 * Observed in production on a fresh 60-respondent run (e8c8f1e1, 2026-08-31):
 * a batch parse failed and retried, generation reported 61 for count=60, and
 * two DIFFERENT people carried one persona_id. Pre pass-48 index that
 * persisted silently as one persona_id holding two profiles and two answer
 * sets. Post-index it became a short count: analysis.n=59 vs
 * respondent_count=60 — billed for 60, delivered 59.
 *
 * The recruit loop already guards this (recruitLoop.js ~L286). These tests
 * pin the batch path's equivalent: drop the collision, top up to `count`.
 */

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// Scripted model output: each call shifts one entry off the queue.
const mockQueue = [];
jest.mock('../src/services/ai/anthropic', () => ({
  MODEL_ROUTING: {},
  callClaude: jest.fn(async () => ({ text: JSON.stringify({ personas: mockQueue.shift() ?? [] }) })),
  extractJSON: (t) => JSON.parse(t),
}));

const { generatePersonas } = require('../src/services/ai/personas');
const { callClaude } = require('../src/services/ai/anthropic');

const mission = { id: 'm-1', user_id: 'u-1', targeting: { geography: { countries: ['AE'] } } };
const person = (id, name) => ({ id, first_name: name || `N${id}`, age: 30, country: 'AE' });
/** n personas with sequential ids from `from`. */
const batchOf = (n, from = 1) =>
  Array.from({ length: n }, (_, i) => person(`P${String(from + i).padStart(3, '0')}`));

beforeEach(() => { mockQueue.length = 0; callClaude.mockClear(); });

test('happy path: distinct ids across batches are all kept', async () => {
  mockQueue.push(batchOf(10, 1), batchOf(10, 11));
  const out = await generatePersonas(mission, 20);
  expect(out).toHaveLength(20);
  expect(new Set(out.map((p) => p.id)).size).toBe(20);
});

test('THE BUG: two parallel batches re-emitting the same ids no longer collide', async () => {
  // Both batches ignore startIndex and emit P001..P010 (what the model did).
  mockQueue.push(batchOf(10, 1), batchOf(10, 1), batchOf(10, 101));
  const out = await generatePersonas(mission, 20);
  const ids = out.map((p) => p.id);
  expect(new Set(ids).size).toBe(ids.length);          // no duplicate ids
  expect(out).toHaveLength(20);                        // and still 20 delivered
});

test('a duplicate id is DROPPED, not renumbered (never clones a respondent)', async () => {
  // Second batch repeats P001 with a DIFFERENT person, then one fresh id.
  mockQueue.push([person('P001', 'Amir')], [person('P001', 'Layla'), person('P002', 'Zaid')]);
  const out = await generatePersonas(mission, 2);
  expect(out.map((p) => p.id)).toEqual(['P001', 'P002']);
  // The kept P001 is the FIRST one; Layla was discarded, not given a new id.
  expect(out.find((p) => p.id === 'P001').first_name).toBe('Amir');
  expect(out.some((p) => p.first_name === 'Layla')).toBe(false);
});

test('tops up to the requested count after de-duplication', async () => {
  mockQueue.push(batchOf(10, 1), batchOf(10, 1)); // round 1 nets only 10 of 20
  mockQueue.push(batchOf(10, 500));               // top-up supplies the rest
  const out = await generatePersonas(mission, 20);
  expect(out).toHaveLength(20);
  expect(new Set(out.map((p) => p.id)).size).toBe(20);
});

test('a batch dropped entirely (parse failure) is topped up', async () => {
  mockQueue.push(batchOf(10, 1), []);   // second batch returns nothing
  mockQueue.push(batchOf(10, 200));     // top-up
  const out = await generatePersonas(mission, 20);
  expect(out).toHaveLength(20);
});

test('top-up is bounded and never spins forever', async () => {
  // The model ALWAYS returns the same ten ids, no matter the offset.
  for (let i = 0; i < 40; i += 1) mockQueue.push(batchOf(10, 1));
  const out = await generatePersonas(mission, 20);
  expect(out).toHaveLength(10);                  // short, honestly
  expect(new Set(out.map((p) => p.id)).size).toBe(10);
  // 2 batches for round 1 + 3 bounded top-up rounds — not unbounded.
  expect(callClaude.mock.calls.length).toBeLessThanOrEqual(8);
});

test('never returns more than requested even if a batch over-delivers', async () => {
  mockQueue.push(batchOf(11, 1)); // the observed "generated 61 for count 60"
  const out = await generatePersonas(mission, 10);
  expect(out).toHaveLength(10);
});

test('personas with no id are dropped rather than persisted id-less', async () => {
  mockQueue.push([{ first_name: 'NoId', age: 30 }, person('P002')]);
  mockQueue.push([person('P900')]);
  const out = await generatePersonas(mission, 2);
  expect(out.every((p) => p.id || p.persona_id)).toBe(true);
  expect(out).toHaveLength(2);
});

test('excludeIds keeps the retry path from re-issuing a held id', async () => {
  // runMission's replacement round passes the ids it already holds.
  mockQueue.push([person('P001'), person('P002')]);  // both already held
  mockQueue.push([person('P777')]);                  // top-up
  const out = await generatePersonas(mission, 1, {
    stricter: true, excludeIds: new Set(['P001', 'P002']),
  });
  expect(out).toHaveLength(1);
  expect(['P001', 'P002']).not.toContain(out[0].id);
});

test('recruit-loop single-persona call is unaffected', async () => {
  mockQueue.push([person('P001')]);
  const out = await generatePersonas(mission, 1);
  expect(out).toHaveLength(1);
  expect(out[0].id).toBe('P001');
});
