/**
 * A fake PostgREST that enforces the row ceiling a real one enforces.
 *
 * Supabase/PostgREST returns at most `db-max-rows` (1000) rows for a select and
 * says nothing about having truncated - a 200, a short array, no flag. Anything
 * that sums the result is then short without ever looking wrong. That is how
 * the admin cost, gross-profit and margin numbers came to report roughly a
 * third of real AI spend while reading the correct table.
 *
 * A fake that returned every seeded row would let an unpaged handler pass, so
 * this one caps exactly where the real one does: after the requested range is
 * applied, and at 1000 rows when no range was requested.
 *
 * Shared module-level state, so a jest.mock factory can pull the same client
 * the test seeds: `jest.mock('../src/db/supabase', () =>
 * require('./helpers/cappedPostgrest').client)`.
 */

/** PostgREST's db-max-rows. The reason paging exists. */
const MAX_ROWS = 1000;

/** table name -> rows. Seed these in the test. */
const tables = {};

/** rpc name -> resolved `data`. Seed these in the test. */
const rpcResponses = {};

function makeChain(table) {
  const filters = [];
  const orders = [];
  let range = null;
  let wantCount = false;

  const chain = {
    select: (_cols, opts) => { if (opts && opts.count === 'exact') wantCount = true; return chain; },
    eq:  (c, v) => { filters.push((r) => r[c] === v); return chain; },
    neq: (c, v) => { filters.push((r) => r[c] !== v); return chain; },
    is:  (c, v) => { filters.push((r) => r[c] === v); return chain; },
    in:  (c, v) => { filters.push((r) => v.includes(r[c])); return chain; },
    gte: (c, v) => { filters.push((r) => r[c] >= v); return chain; },
    lte: (c, v) => { filters.push((r) => r[c] <= v); return chain; },
    lt:  (c, v) => { filters.push((r) => r[c] < v); return chain; },
    gt:  (c, v) => { filters.push((r) => r[c] > v); return chain; },
    not: (c, op, v) => { filters.push((r) => (op === 'is' ? r[c] !== v : true)); return chain; },
    // Text search is irrelevant to the row-cap question; accept and ignore.
    or: () => chain,
    ilike: () => chain,
    order: (col, opts) => { orders.push({ col, ascending: (opts || {}).ascending !== false }); return chain; },
    range: (from, to) => { range = [from, to]; return chain; },
    single: () => ({ then: (f, r) => chain._resolve(true).then(f, r) }),
    maybeSingle: () => ({ then: (f, r) => chain._resolve(true).then(f, r) }),

    _resolve: (single = false) => {
      let out = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
      out.sort((a, b) => {
        for (const o of orders) {
          const av = a[o.col]; const bv = b[o.col];
          if (av === bv) continue;
          if (av === null || av === undefined) return 1;
          if (bv === null || bv === undefined) return -1;
          return o.ascending === false ? (av < bv ? 1 : -1) : (av < bv ? -1 : 1);
        }
        return 0;
      });
      const count = wantCount ? out.length : null;
      // The cap, exactly where a real PostgREST applies it.
      out = range
        ? out.slice(range[0], Math.min(range[1] + 1, range[0] + MAX_ROWS))
        : out.slice(0, MAX_ROWS);
      if (single) return Promise.resolve({ data: out[0] || null, error: null });
      return Promise.resolve({ data: out, error: null, count });
    },

    then: (f, r) => chain._resolve(false).then(f, r),
  };
  return chain;
}

const client = {
  from: (table) => makeChain(table),
  rpc: async (name) => ({ data: Object.prototype.hasOwnProperty.call(rpcResponses, name) ? rpcResponses[name] : null, error: null }),
  auth: { admin: { getUserById: async () => ({ data: { user: {} } }) } },
};

function reset() {
  for (const k of Object.keys(tables)) delete tables[k];
  for (const k of Object.keys(rpcResponses)) delete rpcResponses[k];
}

module.exports = { client, tables, rpcResponses, reset, MAX_ROWS };
