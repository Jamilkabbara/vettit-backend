/**
 * A fake PostgREST that behaves like a real one on a NON-UNIQUE sort key.
 *
 * The whole point of this helper is the tie handling. A real database is under
 * no obligation to return rows with an equal ORDER BY value in a consistent
 * order - the plan, the heap order after an UPDATE, or a parallel scan can all
 * reshuffle them between two identical requests. That is exactly why paging on
 * `created_at` alone drops and duplicates rows: page 2 is computed against a
 * different arrangement than page 1 was.
 *
 * So this fake, after applying every `.order()` key it was given, breaks any
 * REMAINING tie with a permutation that rotates on each query. If the caller's
 * sort is total (it ends in a unique column) the rotation is unobservable and
 * paging is stable. If the sort is not total, the rotation shows up as rows
 * appearing twice and rows disappearing - the production defect, reproduced.
 *
 * A mock that just returned insertion order would pass with and without the
 * fix, which is worse than no test at all.
 */

/** Compare two values the way Postgres orders them, NULLs last by default. */
function cmp(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return a < b ? -1 : 1;
}

/**
 * Build a mock `supabase` module object.
 *
 * @param {Record<string, object[]>} tables  table name -> rows
 * @returns {{ client: object, orderCalls: object[], rangeCalls: number[][], reset: Function }}
 */
function makeUnstableSupabase(tables) {
  const orderCalls = [];
  const rangeCalls = [];
  // Rotates every query so tied rows come back arranged differently each time.
  let queryCounter = 0;

  const makeChain = (table) => {
    const rows = () => (tables[table] || []).slice();
    const filters = [];
    const orders = [];
    let range = null;
    let limit = null;
    let wantCount = false;

    const chain = {
      select: (_cols, opts) => {
        if (opts && opts.count === 'exact') wantCount = true;
        return chain;
      },
      eq: (col, val) => { filters.push((r) => r[col] === val); return chain; },
      neq: (col, val) => { filters.push((r) => r[col] !== val); return chain; },
      is: (col, val) => { filters.push((r) => r[col] === val); return chain; },
      in: (col, vals) => { filters.push((r) => vals.includes(r[col])); return chain; },
      gte: (col, val) => { filters.push((r) => r[col] >= val); return chain; },
      lte: (col, val) => { filters.push((r) => r[col] <= val); return chain; },
      // Search filters are irrelevant to the paging question; accept and ignore.
      or: () => chain,
      ilike: () => chain,
      order: (col, opts) => {
        const o = { table, col, ascending: true, ...(opts || {}) };
        orders.push(o);
        orderCalls.push(o);
        return chain;
      },
      range: (from, to) => { range = [from, to]; rangeCalls.push([from, to]); return chain; },
      limit: (n) => { limit = n; return chain; },
      maybeSingle: () => chain.then.bind(chain) && {
        then: (onF, onR) => chain._resolve(true).then(onF, onR),
      },
      single: () => ({ then: (onF, onR) => chain._resolve(true).then(onF, onR) }),

      _resolve: (single = false) => {
        const seq = queryCounter++;
        let out = rows().filter((r) => filters.every((f) => f(r)));

        // Decorate with a per-query tie-break rank BEFORE sorting, so the
        // arrangement of equal rows differs from one request to the next.
        const decorated = out.map((r, i) => ({
          r,
          shuffle: (i * 7919 + seq * 104729) % Math.max(out.length, 1),
        }));
        decorated.sort((x, y) => {
          for (const o of orders) {
            const d = cmp(x.r[o.col], y.r[o.col]);
            if (d !== 0) return o.ascending === false ? -d : d;
          }
          // Still tied after every ORDER BY key the caller supplied.
          return x.shuffle - y.shuffle;
        });
        out = decorated.map((d) => d.r);

        const count = wantCount ? out.length : null;
        if (range) out = out.slice(range[0], range[1] + 1);
        else if (limit != null) out = out.slice(0, limit);

        if (single) return Promise.resolve({ data: out[0] || null, error: null });
        return Promise.resolve({ data: out, error: null, count });
      },

      then: (onF, onR) => chain._resolve(false).then(onF, onR),
    };
    return chain;
  };

  return {
    client: {
      from: (table) => makeChain(table),
      rpc: async () => ({ data: null, error: null }),
      auth: { admin: { getUserById: async () => ({ data: { user: {} } }) } },
    },
    orderCalls,
    rangeCalls,
    reset: () => {
      orderCalls.length = 0;
      rangeCalls.length = 0;
      queryCounter = 0;
    },
  };
}

module.exports = { makeUnstableSupabase };
