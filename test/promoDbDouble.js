/**
 * A stand-in for the promo_codes table that behaves the way Postgres does for
 * the one thing these tests are about: a conditional UPDATE either matches a
 * row or it does not, and the filters are evaluated against the row AS IT IS
 * AT THAT MOMENT, not as the caller last read it.
 *
 * Without that, a test double happily "updates" a row whose count has already
 * moved and the race the fix exists to stop becomes invisible.
 *
 * Also implements the pass-53 claim_promo_code / release_promo_code functions
 * as rpc(), including the (code, mission_id) ledger, so the tests can drive
 * both the deployed and the not-yet-deployed shape of the same contract.
 */

function matches(row, filters) {
  return filters.every(([op, col, val]) => {
    const cell = row[col] === undefined ? null : row[col];
    if (op === 'eq') return cell === val;
    if (op === 'lt') return Number(cell ?? 0) < Number(val);
    if (op === 'gt') return Number(cell ?? 0) > Number(val);
    if (op === 'is') return cell === val;
    throw new Error(`promoDbDouble: unsupported filter ${op}`);
  });
}

/**
 * @param {object[]} seedRows promo_codes rows
 * @param {object}   [opts]
 * @param {boolean}  [opts.rpcDeployed=false] pretend pass-53 is applied
 * @param {Function} [opts.onRead] awaited on every promo_codes read, so a test
 *                                 can interleave two claims deliberately
 */
function makePromoDb(seedRows, opts = {}) {
  const rows = seedRows.map((r) => ({ uses_count: 0, active: true, ...r }));
  const ledger = new Set();           // `${code}::${missionId}`
  const onRead = opts.onRead || (async () => {});
  const rpcDeployed = !!opts.rpcDeployed;
  // Make every write to promo_codes fail, the way a real one can. The point is
  // that a failed increment must not look like a successful one.
  const failWrites = !!opts.failWrites;
  const calls = { claims: 0, releases: 0, updates: 0 };

  const find = (code) => rows.find((r) => r.code === code);

  function chain(table) {
    const state = { mode: 'select', patch: null, filters: [] };

    const apply = () => {
      const hits = rows.filter((r) => matches(r, state.filters));
      if (state.mode === 'update') {
        calls.updates += 1;
        if (failWrites) return { data: null, error: { message: 'write refused', code: '55P03' } };
        hits.forEach((r) => Object.assign(r, state.patch));
      }
      return { data: hits.map((r) => ({ ...r })), error: null };
    };

    const api = {
      select: () => api,
      update: (patch) => { state.mode = 'update'; state.patch = patch; return api; },
      insert: () => api,
      eq: (col, val) => { state.filters.push(['eq', col, val]); return api; },
      lt: (col, val) => { state.filters.push(['lt', col, val]); return api; },
      gt: (col, val) => { state.filters.push(['gt', col, val]); return api; },
      is: (col, val) => { state.filters.push(['is', col, val]); return api; },
      order: () => api,
      limit: () => api,
      single: async () => {
        await onRead(table);
        const { data } = apply();
        return data.length
          ? { data: data[0], error: null }
          : { data: null, error: { message: 'not found', code: 'PGRST116' } };
      },
      maybeSingle: async () => {
        await onRead(table);
        const { data } = apply();
        return { data: data[0] || null, error: null };
      },
      then: (onFulfilled, onRejected) => {
        const settle = async () => {
          if (state.mode === 'select') await onRead(table);
          return apply();
        };
        return settle().then(onFulfilled, onRejected);
      },
    };
    return api;
  }

  // The pass-53 function, in JavaScript. Same order of operations: reserve the
  // mission's ledger slot, then increment only while there is room, then undo
  // the reservation if there was not.
  function claimPromoCode(code, missionId, source) {
    calls.claims += 1;
    const key = `${code}::${missionId}`;
    const row = find(code);
    if (!row) return { claimed: false, reason: 'not_found' };
    if (ledger.has(key)) {
      return { claimed: true, reason: 'already_redeemed', uses_count: row.uses_count, max_uses: row.max_uses };
    }
    ledger.add(key);
    const limit = Number(row.max_uses) > 0 ? Number(row.max_uses) : null;
    const expired = row.expires_at && new Date(row.expires_at) < new Date();
    if (row.active === false) { ledger.delete(key); return { claimed: false, reason: 'inactive' }; }
    if (expired)              { ledger.delete(key); return { claimed: false, reason: 'expired' }; }
    if (limit !== null && (row.uses_count || 0) >= limit) {
      ledger.delete(key);
      return { claimed: false, reason: 'exhausted', uses_count: row.uses_count, max_uses: row.max_uses };
    }
    row.uses_count = (row.uses_count || 0) + 1;
    void source;
    return { claimed: true, reason: 'claimed', uses_count: row.uses_count, max_uses: row.max_uses };
  }

  function releasePromoCode(code, missionId) {
    calls.releases += 1;
    const key = `${code}::${missionId}`;
    if (!ledger.has(key)) return { released: false, reason: 'nothing_to_release' };
    ledger.delete(key);
    const row = find(code);
    if (row) row.uses_count = Math.max((row.uses_count || 0) - 1, 0);
    return { released: true, reason: 'released' };
  }

  const db = {
    from: (table) => chain(table),
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'u1@test.dev' } } }) } },
    rows,
    ledger,
    calls,
    row: find,
    // Not deployed yet: PostgREST answers "function not found in schema cache".
    rpc: async (fn, args) => {
      if (!rpcDeployed) {
        return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${fn}` } };
      }
      if (fn === 'claim_promo_code') {
        return { data: claimPromoCode(args.p_code, args.p_mission_id, args.p_source), error: null };
      }
      if (fn === 'release_promo_code') {
        return { data: releasePromoCode(args.p_code, args.p_mission_id), error: null };
      }
      return { data: null, error: { code: '42883', message: 'undefined function' } };
    },
  };
  return db;
}

/**
 * A gate: the first `n` callers all wait until the nth arrives, so two claims
 * can be made to read the same count before either writes. Opens permanently
 * after that, so retries are not blocked.
 */
function makeGate(n) {
  let arrived = 0;
  let open = false;
  let release;
  const opened = new Promise((resolve) => { release = resolve; });
  return async () => {
    if (open) return;
    arrived += 1;
    if (arrived >= n) { open = true; release(); return; }
    await opened;
  };
}

module.exports = { makePromoDb, makeGate };
