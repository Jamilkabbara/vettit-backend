/*
 * WO §3.3 — market_entry (geo demand validation): a concept-test + light
 * pricing + barrier read, localised to one or more target markets.
 *
 * Doctrine: deterministic math here; the narrator only writes prose about it.
 *
 * QUESTION-METADATA CONTRACT (emitted by the generator, consumed here):
 *   every question carries `kind` ∈ {screener, appeal, intent, wtp, barrier,
 *   competitive, localisation}. appeal = 1–7 rating; intent = 5-pt single
 *   (top-2-box = "Definitely/Probably would buy"); wtp = numeric/price; barrier
 *   + competitive = multi-select; localisation = text/multi.
 *
 * Per-market grouping: a respondent's market is read from
 *   persona_profile.market | _market | country, falling back to a single
 *   "Overall" market when responses aren't market-tagged.
 *
 * Per market we compute: purchase-intent top-2-box %, appeal mean, WTP (mean of
 * numeric answers), ranked adoption barriers, the local competitive set, a 0–100
 * demand index, and a go / caution / no-go signal. WTP/demand are GATED at
 * n ≥ 30 (WO §2.4) — below that the market reads directional.
 *
 * Output:
 *   { methodology:'market_entry', n, markets:[ { market, n, demand_index,
 *     signal:'go'|'caution'|'no_go', purchase_intent_pct, appeal_mean, wtp,
 *     barriers:[{label,pct}], competitors:[{label,pct}], directional:bool } ],
 *     recommended_market, top_barrier, best_demand_index }
 */

const { byQuestion, personaCount, num, distribution, shares } = require('./shared');

const MIN_RELIABLE_N = 30; // WO §2.4 — below this a market reads directional
const INTENT_TOP2 = new Set(['definitely would buy', 'probably would buy']);
const APPEAL_MAX = 7;
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

function marketOf(row) {
  const p = row.persona_profile || {};
  return (p.market || p._market || p.country || row.market || '').toString().trim() || null;
}

function computeMarketEntry(rows, questions, mission) {
  const skeleton = {
    methodology: 'market_entry',
    n: 0,
    markets: [],
    recommended_market: null,
    top_barrier: null,
    best_demand_index: null,
    reason: null,
  };
  try {
    const qs = Array.isArray(questions) ? questions : (Array.isArray(mission?.questions) ? mission.questions : []);
    const all = Array.isArray(rows) ? rows : [];
    const n = personaCount(all);
    const qById = (kind) => qs.filter((q) => q && q.kind === kind);
    const firstId = (kind) => (qById(kind)[0] || {}).id || null;

    // Resolve the market label for every persona (single "Overall" fallback).
    const personaMarket = new Map();
    for (const r of all) {
      if (!r.persona_id) continue;
      if (!personaMarket.has(r.persona_id)) personaMarket.set(r.persona_id, marketOf(r));
    }
    const declared = Array.isArray(mission?.targeted_markets) ? mission.targeted_markets
      : (Array.isArray(mission?.target_markets) ? mission.target_markets : []);
    const anyTagged = [...personaMarket.values()].some(Boolean);
    const marketFor = (pid) => (anyTagged ? (personaMarket.get(pid) || 'Unspecified') : (declared[0] || 'Target market'));

    const marketSet = anyTagged
      ? [...new Set([...personaMarket.values()].filter(Boolean))]
      : [declared[0] || 'Target market'];

    const appealId = firstId('appeal');
    const intentId = firstId('intent');
    const wtpId = firstId('wtp');
    const barrierIds = qById('barrier').map((q) => q.id);
    const compIds = qById('competitive').map((q) => q.id);

    const rowsForMarket = (mk, ids) => all.filter((r) => ids.includes(r.question_id)
      && marketFor(r.persona_id) === mk);

    const markets = marketSet.map((mk) => {
      const intentRows = intentId ? rowsForMarket(mk, [intentId]) : [];
      const intentBase = new Set(intentRows.map((r) => r.persona_id)).size;
      const intentTop2 = intentRows.filter((r) => INTENT_TOP2.has(norm(r.answer))).length;
      const purchase_intent_pct = intentBase ? round1((intentTop2 / intentBase) * 100) : null;

      const appealRows = appealId ? rowsForMarket(mk, [appealId]) : [];
      const appealVals = appealRows.map((r) => num(r.answer)).filter((v) => v !== null && v >= 1 && v <= APPEAL_MAX);
      const appeal_mean = appealVals.length ? round2(appealVals.reduce((s, v) => s + v, 0) / appealVals.length) : null;

      const wtpRows = wtpId ? rowsForMarket(mk, [wtpId]) : [];
      const wtpVals = wtpRows.map((r) => num(r.answer)).filter((v) => v !== null && v > 0);
      const wtp = wtpVals.length ? round2(wtpVals.reduce((s, v) => s + v, 0) / wtpVals.length) : null;

      const barrierRows = barrierIds.length ? rowsForMarket(mk, barrierIds) : [];
      const barrierBase = new Set(barrierRows.map((r) => r.persona_id)).size;
      const barriers = barrierBase
        ? Object.entries(shares(distribution(barrierRows), barrierBase).shares)
          .map(([label, s]) => ({ label, pct: s.pct })).sort((a, b) => b.pct - a.pct).slice(0, 6)
        : [];

      const compRows = compIds.length ? rowsForMarket(mk, compIds) : [];
      const compBase = new Set(compRows.map((r) => r.persona_id)).size;
      const competitors = compBase
        ? Object.entries(shares(distribution(compRows), compBase).shares)
          .map(([label, s]) => ({ label, pct: s.pct })).sort((a, b) => b.pct - a.pct).slice(0, 6)
        : [];

      const mn = new Set(all.filter((r) => marketFor(r.persona_id) === mk).map((r) => r.persona_id)).size;

      // demand index 0–100: appeal (40%) + intent (40%) + barrier-freeness (20%).
      const appealNorm = appeal_mean != null ? ((appeal_mean - 1) / (APPEAL_MAX - 1)) * 100 : null;
      const topBarrierPct = barriers.length ? barriers[0].pct : 0;
      const barrierFreeness = 100 - Math.min(100, topBarrierPct);
      const parts = [];
      if (appealNorm != null) parts.push([appealNorm, 0.4]);
      if (purchase_intent_pct != null) parts.push([purchase_intent_pct, 0.4]);
      parts.push([barrierFreeness, 0.2]);
      const wsum = parts.reduce((s, [, w]) => s + w, 0) || 1;
      const demand_index = parts.length
        ? Math.round(parts.reduce((s, [v, w]) => s + v * w, 0) / wsum)
        : null;

      const signal = demand_index == null ? null
        : demand_index >= 60 ? 'go' : demand_index >= 40 ? 'caution' : 'no_go';

      return {
        market: mk,
        n: mn,
        directional: mn < MIN_RELIABLE_N,
        demand_index,
        signal,
        purchase_intent_pct,
        appeal_mean,
        wtp,
        barriers,
        competitors,
      };
    }).sort((a, b) => (b.demand_index ?? -1) - (a.demand_index ?? -1));

    const best = markets.find((m) => m.demand_index != null) || null;
    // top barrier across all markets
    const barrierAgg = {};
    markets.forEach((m) => m.barriers.forEach((b) => { barrierAgg[b.label] = (barrierAgg[b.label] || 0) + b.pct; }));
    const top_barrier = Object.entries(barrierAgg).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    return {
      ...skeleton,
      n,
      markets,
      recommended_market: best ? best.market : null,
      best_demand_index: best ? best.demand_index : null,
      top_barrier,
      reason: markets.every((m) => m.directional)
        ? `Directional — every market sample is below n=${MIN_RELIABLE_N}; read demand and WTP as signal, not fixed figures.`
        : null,
    };
  } catch (err) {
    return { ...skeleton, reason: 'Market-entry analysis could not be computed; see raw responses.' };
  }
}

module.exports = { computeMarketEntry, MIN_RELIABLE_N };
