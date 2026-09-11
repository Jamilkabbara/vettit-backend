/**
 * fetchAllRows — read an aggregate query to completion instead of to 1000 rows.
 *
 * WHY THIS EXISTS
 * ---------------
 * Supabase/PostgREST caps every unbounded SELECT at 1000 rows (`db-max-rows`).
 * It does not error, warn, or set a flag - it returns the first 1000 rows and a
 * 200. Anything that then SUMs the result is short by however much it never
 * saw, and it is short SILENTLY.
 *
 * That is exactly how a cost figure goes wrong. Measured against production on
 * 2026-09-11: `ai_calls` holds 3,434 rows, the last 30 days alone hold 1,903,
 * and the per-mission rollup the admin Missions tab runs
 * (`.in('mission_id', <50 ids>)`) came back with exactly 1000 rows and summed
 * to $4.50 against a true $12.63. Every admin cost, gross-profit and margin
 * number built on an unpaged read of `ai_calls` was understating spend by about
 * two thirds, and understating spend always flatters margin.
 *
 * `ai_calls` is the record of truth for AI spend. Reading it short is the same
 * class of failure as reading the denormalised mission column: the number on
 * the screen is not the number in the log.
 *
 * `src/db/fetchAllResponses.js` does this for `mission_responses`, which is the
 * other table big enough to trip the cap. This is the general version for
 * aggregate reads - use it for any SELECT whose result is summed, counted or
 * grouped rather than shown one row at a time.
 *
 * HOW IT WORKS
 * ------------
 * Pages with `.range(offset, offset + pageSize - 1)` until a short page comes
 * back. Rows are ordered by `id` so the pages tile the table exactly once -
 * without a deterministic sort PostgREST may order rows differently per page,
 * which drops and duplicates rows across page boundaries. A hard cap bounds the
 * loop; hitting it warns, because a capped read is still a truncated read.
 *
 * Returns `{ data, error }`, the same shape a supabase query resolves to, so
 * call sites keep their existing error handling verbatim.
 *
 * Counts (`{ count: 'exact', head: true }`), inserts and deletes are NOT
 * subject to the row cap and deliberately do not use this helper.
 */

const logger = require('../utils/logger');

/** PostgREST's per-request row ceiling. Pages are read at exactly this size. */
const PAGE_SIZE = 1000;

/** Safety valve: stop after this many rows (200 pages). */
const DEFAULT_MAX_ROWS = 200000;

/**
 * @param {object}   supabase          supabase client (service-role)
 * @param {object}   opts
 * @param {string}   opts.table        table name
 * @param {string}   opts.columns      projection, passed straight to `.select()`
 * @param {function} [opts.build]      applies the call site's filters to the
 *                                     query builder and returns it, e.g.
 *                                     `(q) => q.in('mission_id', ids)`
 * @param {string}   [opts.orderColumn] stable sort key (default 'id')
 * @param {number}   [opts.pageSize]   rows per page (default 1000)
 * @param {number}   [opts.maxRows]    hard cap on total rows (default 200000)
 * @param {string}   [opts.label]      call-site name, used in the warn log
 * @returns {Promise<{data: Array|null, error: object|null}>}
 */
async function fetchAllRows(supabase, {
  table,
  columns,
  build = (q) => q,
  orderColumn = 'id',
  pageSize = PAGE_SIZE,
  maxRows = DEFAULT_MAX_ROWS,
  label = 'fetchAllRows',
} = {}) {
  const all = [];
  let offset = 0;

  for (;;) {
    const { data, error } = await build(supabase.from(table).select(columns))
      .order(orderColumn, { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) return { data: null, error };

    const page = Array.isArray(data) ? data : [];
    all.push(...page);

    // A short page is the last page - this is the normal exit.
    if (page.length < pageSize) break;

    offset += pageSize;

    if (offset >= maxRows) {
      logger.warn('fetchAllRows: hard row cap hit - result is TRUNCATED', {
        label, table, maxRows, rowsRead: all.length,
      });
      break;
    }
  }

  return { data: all, error: null };
}

module.exports = fetchAllRows;
module.exports.fetchAllRows = fetchAllRows;
module.exports.PAGE_SIZE = PAGE_SIZE;
module.exports.DEFAULT_MAX_ROWS = DEFAULT_MAX_ROWS;
