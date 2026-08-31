/**
 * Pass 51 — fetchAllResponses pagination.
 *
 * Supabase/PostgREST silently caps unbounded SELECTs at 1000 rows, so every
 * mission_responses read has to page. These tests pin the loop: it must keep
 * requesting pages while a page comes back FULL, stop on the first SHORT page,
 * concatenate in order, carry each call site's filters/projection through
 * untouched, and refuse to spin forever when the hard cap is reached.
 */

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const logger = require('../src/utils/logger');
const fetchAllResponses = require('../src/db/fetchAllResponses');

/** n rows tagged with a page marker so ordering/concatenation is observable. */
function rows(n, tag) {
  return Array.from({ length: n }, (_, i) => ({ id: `${tag}-${i}`, question_id: 'q1' }));
}

/**
 * Supabase stub. `pages` is the sequence of row arrays to serve, one per
 * .range() call. Records every call so filters and projections can be asserted.
 */
function makeSupabase(pages, { error = null } = {}) {
  const calls = { tables: [], selects: [], eqs: [], orders: [], ranges: [] };
  let pageIdx = 0;
  const supabase = {
    calls,
    from(table) {
      calls.tables.push(table);
      const chain = {
        select: (cols) => { calls.selects.push(cols); return chain; },
        eq: (col, val) => { calls.eqs.push([col, val]); return chain; },
        order: (col, opts) => { calls.orders.push([col, opts]); return chain; },
        range: (from, to) => {
          calls.ranges.push([from, to]);
          const page = pages[pageIdx] || [];
          pageIdx += 1;
          return Promise.resolve(error ? { data: null, error } : { data: page, error: null });
        },
      };
      return chain;
    },
  };
  return supabase;
}

beforeEach(() => { logger.warn.mockClear(); });

describe('fetchAllResponses — pagination loop', () => {
  it('concatenates a full first page with a short second page and terminates', async () => {
    // The production bug in one test: 1440 rows arrive as 1000 + 440.
    const supabase = makeSupabase([rows(1000, 'p0'), rows(440, 'p1')]);

    const { data, error } = await fetchAllResponses(supabase, {
      missionId: 'm1',
      columns: 'question_id, answer',
    });

    expect(error).toBeNull();
    expect(data).toHaveLength(1440);           // NOT 1000 — the whole point
    expect(supabase.calls.ranges).toEqual([[0, 999], [1000, 1999]]);
    // Loop stopped on the short page: exactly two requests, no third.
    expect(supabase.calls.ranges).toHaveLength(2);
    // Concatenated in page order.
    expect(data[0].id).toBe('p0-0');
    expect(data[999].id).toBe('p0-999');
    expect(data[1000].id).toBe('p1-0');
    expect(data[1439].id).toBe('p1-439');
  });

  it('stops after one request when the first page is already short', async () => {
    const supabase = makeSupabase([rows(560, 'only')]);

    const { data } = await fetchAllResponses(supabase, {
      missionId: 'm-small', columns: 'question_id',
    });

    expect(data).toHaveLength(560);
    expect(supabase.calls.ranges).toEqual([[0, 999]]);
  });

  it('treats an exactly-full final page followed by an empty page as done', async () => {
    const supabase = makeSupabase([rows(1000, 'p0'), []]);

    const { data } = await fetchAllResponses(supabase, {
      missionId: 'm-exact', columns: 'question_id',
    });

    expect(data).toHaveLength(1000);
    expect(supabase.calls.ranges).toHaveLength(2);
  });

  it('passes the projection, mission filter, extra eq filters and stable order through', async () => {
    const supabase = makeSupabase([rows(3, 'p0')]);

    await fetchAllResponses(supabase, {
      missionId: 'm2',
      columns: 'persona_id, persona_profile, question_id, answer, exposure_status',
      eq: { screened_out: false },
    });

    expect(supabase.calls.tables).toEqual(['mission_responses']);
    expect(supabase.calls.selects)
      .toEqual(['persona_id, persona_profile, question_id, answer, exposure_status']);
    expect(supabase.calls.eqs).toEqual([['mission_id', 'm2'], ['screened_out', false]]);
    // Deterministic sort is what makes paging safe across page boundaries.
    expect(supabase.calls.orders).toEqual([['id', { ascending: true }]]);
  });

  it('surfaces a query error instead of returning a partial result', async () => {
    const boom = { message: 'connection reset', code: '500' };
    const supabase = makeSupabase([rows(1000, 'p0')], { error: boom });

    const { data, error } = await fetchAllResponses(supabase, {
      missionId: 'm3', columns: 'question_id',
    });

    expect(data).toBeNull();
    expect(error).toBe(boom);
  });

  it('stops at the hard cap and warns that the result is truncated', async () => {
    // Every page comes back full, so only the cap can end the loop.
    const alwaysFull = Array.from({ length: 50 }, (_, i) => rows(10, `p${i}`));
    const supabase = makeSupabase(alwaysFull);

    const { data } = await fetchAllResponses(supabase, {
      missionId: 'runaway',
      columns: 'question_id',
      pageSize: 10,
      maxRows: 30,
      label: 'unit-test',
    });

    expect(data).toHaveLength(30);
    expect(supabase.calls.ranges).toEqual([[0, 9], [10, 19], [20, 29]]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/TRUNCATED/);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({
      label: 'unit-test', missionId: 'runaway', maxRows: 30, rowsRead: 30,
    });
  });

  it('does not warn on a normal multi-page read', async () => {
    const supabase = makeSupabase([rows(1000, 'p0'), rows(1, 'p1')]);
    await fetchAllResponses(supabase, { missionId: 'm4', columns: 'question_id' });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
