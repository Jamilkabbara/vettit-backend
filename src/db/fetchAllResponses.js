/**
 * fetchAllResponses — the ONLY sanctioned way to read rows out of
 * `mission_responses`.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Supabase/PostgREST caps every unbounded SELECT at 1000 rows
 * (`db-max-rows`). It does NOT error, warn, or set a flag — it just
 * returns the first 1000 rows and a 200. A plain
 *
 *     await supabase.from('mission_responses').select(cols).eq('mission_id', id)
 *
 * therefore SILENTLY TRUNCATES on any mission with more than 1000
 * response rows. Rows are one per persona per question, so a 120-persona
 * × 12-question mission is already over the line. Proven in production:
 * mission bdae4d45-9a85-40f2-a32a-51cce7ef37e0 holds 1440 rows and an
 * unbounded read returns exactly 1000.
 *
 * The damage is not cosmetic. Truncated reads corrupt exports, the
 * results copilot, every insights backfill, and — worst — the
 * recruit-loop RESUME path, which rebuilds in-memory state from this
 * table: a short read there restores only a fraction of the qualified
 * personas and then RE-INSERTS duplicates for the ones it "lost".
 *
 * So: every caller MUST go through this helper. Do not hand-roll a
 * `.from('mission_responses').select(...)` read. If you need a shape this
 * helper does not cover, extend the helper — do not bypass it.
 *
 * HOW IT WORKS
 * ────────────
 * Pages with `.range(offset, offset + pageSize - 1)` until a short page
 * comes back (a page smaller than pageSize means the last page). Results
 * are ordered by the `id` primary key so paging is stable — without a
 * deterministic sort PostgREST may return rows in a different order per
 * page, which silently duplicates and drops rows across page boundaries.
 *
 * A hard cap bounds the loop so a pathological mission (or a filter bug)
 * can never spin forever; hitting the cap emits a warn log, because a
 * capped read is still a truncated read and ops needs to know.
 *
 * Returns `{ data, error }` — the same shape a supabase query resolves
 * to — so call sites keep their existing error handling verbatim. On
 * error, `data` is null and the raw PostgREST error is passed through.
 *
 * NOTE: counts (`{ count: 'exact', head: true }`), inserts and deletes are
 * NOT affected by the row cap and deliberately do not use this helper.
 */

const logger = require('../utils/logger');

/** PostgREST's per-request row ceiling. Pages are read at exactly this size. */
const PAGE_SIZE = 1000;

/** Safety valve: stop after this many rows for one mission (100 pages). */
const DEFAULT_MAX_ROWS = 100000;

/**
 * Read every `mission_responses` row for a mission, paging past the
 * 1000-row PostgREST cap.
 *
 * @param {object} supabase           supabase client (service-role)
 * @param {object} opts
 * @param {string} opts.missionId     mission_id to filter on (required)
 * @param {string} opts.columns       column projection, passed straight to
 *                                    `.select()` — preserve your call site's
 *                                    existing projection exactly
 * @param {object} [opts.eq]          extra equality filters, e.g.
 *                                    `{ screened_out: false }`
 * @param {number} [opts.pageSize]    rows per page (default 1000)
 * @param {number} [opts.maxRows]     hard cap on total rows (default 100000)
 * @param {string} [opts.label]       call-site name, used in the warn log
 * @returns {Promise<{data: Array|null, error: object|null}>}
 */
async function fetchAllResponses(supabase, {
  missionId,
  columns,
  eq = {},
  pageSize = PAGE_SIZE,
  maxRows = DEFAULT_MAX_ROWS,
  label = 'fetchAllResponses',
} = {}) {
  const all = [];
  let offset = 0;

  for (;;) {
    let q = supabase
      .from('mission_responses')
      .select(columns)
      .eq('mission_id', missionId);

    for (const [column, value] of Object.entries(eq)) {
      q = q.eq(column, value);
    }

    const { data, error } = await q
      .order('id', { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) return { data: null, error };

    const page = Array.isArray(data) ? data : [];
    all.push(...page);

    // A short page is the last page — this is the normal exit.
    if (page.length < pageSize) break;

    offset += pageSize;

    if (offset >= maxRows) {
      logger.warn('fetchAllResponses: hard row cap hit — result is TRUNCATED', {
        label, missionId, maxRows, rowsRead: all.length,
      });
      break;
    }
  }

  return { data: all, error: null };
}

module.exports = fetchAllResponses;
module.exports.fetchAllResponses = fetchAllResponses;
module.exports.PAGE_SIZE = PAGE_SIZE;
module.exports.DEFAULT_MAX_ROWS = DEFAULT_MAX_ROWS;
