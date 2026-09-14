/**
 * Runs the REAL analyzeCreative end to end with the model stubbed and an
 * in-memory database, and hands back what was sent and what was saved.
 *
 * The calling test file must declare the module mocks (jest.mock is hoisted
 * per file) using the `mockCa` state object below; this helper only drives
 * them. See test/ca_market_qualitative.test.js for the canonical block.
 */
const supabase = require('../../src/db/supabase');
const { analyzeCreative } = require('../../src/services/ai/creativeAttention');

const MARKETS = {
  SA: 'Saudi Arabia',
  AE: 'United Arab Emirates',
  EG: 'Egypt',
};

function fakeDb(missionRow) {
  const row = { ...missionRow };
  const saved = { missionPatches: [] };

  function chain(table) {
    const st = { op: 'select', patch: null, filters: [], returning: false };
    const rowsFor = () => {
      if (table === 'missions') return [row];
      if (table === 'markets_master') return Object.entries(MARKETS).map(([code, display_name]) => ({ code, display_name }));
      return [];
    };
    const evaluate = () => {
      const matching = rowsFor().filter((r) => st.filters.every(([k, v]) => r[k] === v));
      if (st.op === 'update' && table === 'missions') matching.forEach((r) => Object.assign(r, st.patch));
      return { data: (st.returning || st.op !== 'update') ? matching : null, error: null };
    };
    const api = {
      select: () => { if (st.op === 'update') st.returning = true; return api; },
      update: (patch) => { st.op = 'update'; st.patch = patch; if (table === 'missions') saved.missionPatches.push(patch); return api; },
      insert: async () => ({ data: null, error: null }),
      eq: (k, v) => { st.filters.push([k, v]); return api; },
      lt: () => api, limit: () => api, order: () => api, range: () => api,
      single: async () => { const { data } = evaluate(); return data && data.length === 1 ? { data: data[0], error: null } : { data: null, error: { code: 'PGRST116' } }; },
      maybeSingle: async () => { const { data } = evaluate(); return { data: (data && data[0]) || null, error: null }; },
      then: (resolve, reject) => Promise.resolve(evaluate()).then(resolve, reject),
    };
    return api;
  }
  supabase.from.mockImplementation(chain);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
  supabase.storage.from.mockImplementation(() => ({
    download: async () => ({ data: { arrayBuffer: async () => jpeg }, error: null }),
  }));
  return saved;
}

async function runAnalysis(mockCa, mission) {
  mockCa.framePrompts = [];
  mockCa.synthPrompts = [];
  mockCa.marketPrompts = [];
  const saved = fakeDb({ ...mission, status: 'processing' });
  await analyzeCreative({ mission });
  const completion = saved.missionPatches.find((p) => p && p.creative_analysis);
  return {
    analysis: completion ? completion.creative_analysis : null,
    framePrompts: mockCa.framePrompts,
    synthPrompts: mockCa.synthPrompts,
    marketPrompts: mockCa.marketPrompts,
  };
}

/** Every number (and its path) in an object, skipping the listed top-level keys. */
function numericLeaves(obj, skipTopLevel = []) {
  const out = {};
  const walk = (v, p) => {
    if (typeof v === 'number') { out[p] = v; return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${p}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (!p && skipTopLevel.includes(k)) continue;
        walk(x, p ? `${p}.${k}` : k);
      }
    }
  };
  walk(obj, '');
  return out;
}

module.exports = { runAnalysis, numericLeaves, MARKETS };
