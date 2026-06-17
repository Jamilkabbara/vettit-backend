/*
 * WO §3.2 — audience_profiling (psychographic + behavioural segmentation).
 *
 * Doctrine (matches every other analysis module): the LLM does NOT compute the
 * segmentation. computeAudienceProfiling(rows, questions, mission) clusters
 * respondents deterministically from their attitudinal answers and profiles
 * each segment; the narrator only writes prose ABOUT the returned object.
 *
 * QUESTION-METADATA CONTRACT (emitted by the generator, consumed here):
 *   every question carries `kind` ∈ {screener, behavioural, attitudinal,
 *   needs, media}; attitudinal questions additionally carry `dimension` ∈
 *   ATTITUDE_DIMENSIONS and are 1–7 agree/disagree ratings. The attitudinal
 *   battery is the clustering basis; behavioural/needs/media drive the profile.
 *
 * GATING (WO §2.4): clustering requires n ≥ MIN_CLUSTER_N (50). Below that we
 * return an aggregate profile only (segments:null) and say so — never fabricate
 * segments from a tiny sample.
 *
 * Output shape:
 *   { methodology:'audience_profiling', n, posture:'segmented'|'aggregate',
 *     dimensions:[...],
 *     aggregate:{ attitudes:{dim:{mean,n}}, behaviours:[...], media:[...], needs:[...] },
 *     segments:[ { id,name,size_pct,n,is_primary, attitudes:{dim:mean},
 *                  signature:[{dimension,mean,delta}], behaviours, media, needs,
 *                  coords:{x,y} } ] | null,
 *     primary_segment_id, segment_count, key_dimension,
 *     reason:string|null }
 */

const { byQuestion, personaCount, num, distribution, shares } = require('./shared');

const MIN_CLUSTER_N = 50; // WO §2.4 — segmentation gate
const ATTITUDE_DIMENSIONS = [
  'price_sensitivity', 'novelty_seeking', 'brand_loyalty',
  'convenience', 'status', 'sustainability',
];
const DIM_LABELS = {
  price_sensitivity: 'Price sensitivity',
  novelty_seeking: 'Novelty-seeking',
  brand_loyalty: 'Brand loyalty',
  convenience: 'Convenience orientation',
  status: 'Status orientation',
  sustainability: 'Sustainability',
};
const SCALE_MAX = 7;

const round2 = (v) => Math.round(v * 100) / 100;
const round1 = (v) => Math.round(v * 10) / 10;

/* ── deterministic PRNG (mulberry32) so clustering is reproducible run-to-run ── */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function euclid(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

/* k-means++ init + Lloyd iterations, deterministic via seeded rng. */
function kmeans(vectors, k, { iters = 50, seed = 1337 } = {}) {
  const rng = mulberry32(seed);
  const n = vectors.length;
  const dim = vectors[0].length;
  // k-means++ seeding
  const centroids = [vectors[Math.floor(rng() * n)].slice()];
  while (centroids.length < k) {
    const d2 = vectors.map((v) => Math.min(...centroids.map((c) => euclid(v, c) ** 2)));
    const sum = d2.reduce((s, v) => s + v, 0) || 1;
    let r = rng() * sum;
    let idx = 0;
    for (; idx < n; idx += 1) { r -= d2[idx]; if (r <= 0) break; }
    centroids.push(vectors[Math.min(idx, n - 1)].slice());
  }
  let assign = new Array(n).fill(0);
  for (let it = 0; it < iters; it += 1) {
    let moved = false;
    // assign
    for (let i = 0; i < n; i += 1) {
      let best = 0; let bestD = Infinity;
      for (let c = 0; c < centroids.length; c += 1) {
        const d = euclid(vectors[i], centroids[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; moved = true; }
    }
    // update
    const sums = centroids.map(() => new Array(dim).fill(0));
    const counts = centroids.map(() => 0);
    for (let i = 0; i < n; i += 1) {
      counts[assign[i]] += 1;
      for (let d = 0; d < dim; d += 1) sums[assign[i]][d] += vectors[i][d];
    }
    for (let c = 0; c < centroids.length; c += 1) {
      if (counts[c] === 0) continue; // keep empty centroid where it is
      for (let d = 0; d < dim; d += 1) centroids[c][d] = sums[c][d] / counts[c];
    }
    if (!moved && it > 0) break;
  }
  return { assign, centroids };
}

/* Mean silhouette (cosine of fit) to pick k ∈ 2..maxK. Higher = better. */
function silhouette(vectors, assign, k) {
  const n = vectors.length;
  const byC = Array.from({ length: k }, () => []);
  assign.forEach((c, i) => byC[c].push(i));
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const own = byC[assign[i]];
    if (own.length <= 1) continue;
    const a = own.filter((j) => j !== i).reduce((s, j) => s + euclid(vectors[i], vectors[j]), 0) / (own.length - 1);
    let b = Infinity;
    for (let c = 0; c < k; c += 1) {
      if (c === assign[i] || byC[c].length === 0) continue;
      const meanD = byC[c].reduce((s, j) => s + euclid(vectors[i], vectors[j]), 0) / byC[c].length;
      if (meanD < b) b = meanD;
    }
    if (b === Infinity) continue;
    total += (b - a) / Math.max(a, b);
  }
  return total / n;
}

function computeAudienceProfiling(rows, questions, mission) {
  const skeleton = {
    methodology: 'audience_profiling',
    n: 0,
    posture: 'aggregate',
    dimensions: ATTITUDE_DIMENSIONS.map((d) => ({ key: d, label: DIM_LABELS[d] })),
    aggregate: null,
    segments: null,
    primary_segment_id: null,
    segment_count: 0,
    key_dimension: null,
    reason: null,
  };
  try {
    const qs = Array.isArray(questions) ? questions : (Array.isArray(mission?.questions) ? mission.questions : []);
    const byQ = byQuestion(rows);
    const n = personaCount(rows);

    // ── attitudinal battery: question per dimension (first match wins) ──
    const attitudinalQ = {};
    for (const d of ATTITUDE_DIMENSIONS) {
      const q = qs.find((qq) => qq && qq.kind === 'attitudinal' && qq.dimension === d);
      if (q) attitudinalQ[d] = q;
    }
    const presentDims = ATTITUDE_DIMENSIONS.filter((d) => attitudinalQ[d]);

    // ── per-persona attitudinal vectors (only personas answering every present dim) ──
    const byPersonaDim = new Map(); // persona_id → {dim:value}
    for (const d of presentDims) {
      for (const r of (byQ.get(attitudinalQ[d].id) || [])) {
        const v = num(r.answer);
        if (v === null || !r.persona_id) continue;
        if (!byPersonaDim.has(r.persona_id)) byPersonaDim.set(r.persona_id, {});
        byPersonaDim.get(r.persona_id)[d] = Math.max(1, Math.min(SCALE_MAX, v));
      }
    }
    const personas = [...byPersonaDim.entries()].filter(([, vec]) => presentDims.every((d) => vec[d] != null));
    const vectors = personas.map(([, vec]) => presentDims.map((d) => vec[d]));

    // ── aggregate profile (always computed) ──
    const aggAttitudes = {};
    for (const d of presentDims) {
      const vals = personas.map(([, vec]) => vec[d]);
      aggAttitudes[d] = vals.length ? { mean: round2(vals.reduce((s, v) => s + v, 0) / vals.length), n: vals.length, label: DIM_LABELS[d] } : null;
    }
    const profileOf = (idxs) => buildProfile(idxs, personas, presentDims, qs, byQ);
    const aggregate = {
      attitudes: aggAttitudes,
      ...profileOf(personas.map((_, i) => i)),
    };

    // most-divergent dimension overall (highest variance) — the "key dimension"
    let keyDimension = null;
    if (presentDims.length && vectors.length > 1) {
      let bestVar = -1;
      presentDims.forEach((d, di) => {
        const col = vectors.map((v) => v[di]);
        const m = col.reduce((s, v) => s + v, 0) / col.length;
        const varr = col.reduce((s, v) => s + (v - m) ** 2, 0) / col.length;
        if (varr > bestVar) { bestVar = varr; keyDimension = d; }
      });
    }

    // ── gate: below MIN_CLUSTER_N → aggregate only ──
    if (n < MIN_CLUSTER_N || vectors.length < MIN_CLUSTER_N || presentDims.length < 2) {
      return {
        ...skeleton, n, posture: 'aggregate', aggregate, segments: null,
        key_dimension: keyDimension,
        reason: presentDims.length < 2
          ? 'Fewer than two attitudinal dimensions were measured — an aggregate profile is shown.'
          : `Sample too small to segment reliably (n=${vectors.length}, need ≥${MIN_CLUSTER_N}). An aggregate profile is shown instead.`,
      };
    }

    // ── standardize (z-score per dimension) then choose k ∈ 2..4 by silhouette ──
    const means = presentDims.map((_, di) => vectors.reduce((s, v) => s + v[di], 0) / vectors.length);
    const sds = presentDims.map((_, di) => {
      const m = means[di];
      const varr = vectors.reduce((s, v) => s + (v[di] - m) ** 2, 0) / vectors.length;
      return Math.sqrt(varr) || 1;
    });
    const z = vectors.map((v) => v.map((x, di) => (x - means[di]) / sds[di]));

    let best = null;
    for (let k = 2; k <= 4; k += 1) {
      const { assign } = kmeans(z, k, { seed: 1337 + k });
      const distinct = new Set(assign).size;
      if (distinct < k) continue; // degenerate (empty cluster) — skip
      const sil = silhouette(z, assign, k);
      if (!best || sil > best.sil) best = { k, assign, sil };
    }
    if (!best) {
      return { ...skeleton, n, posture: 'aggregate', aggregate, key_dimension: keyDimension,
        reason: 'Respondents did not separate into distinct segments — an aggregate profile is shown.' };
    }

    // ── build each segment ──
    const k = best.k;
    const segIdxs = Array.from({ length: k }, (_, c) => best.assign.map((a, i) => (a === c ? i : -1)).filter((i) => i >= 0));
    const segments = segIdxs.map((idxs, c) => {
      const prof = profileOf(idxs);
      const attitudes = {};
      presentDims.forEach((d, di) => {
        const m = idxs.reduce((s, i) => s + vectors[i][di], 0) / idxs.length;
        attitudes[d] = round2(m);
      });
      // signature: dimensions where this segment most departs from the overall mean
      const signature = presentDims.map((d, di) => ({
        dimension: d, label: DIM_LABELS[d], mean: attitudes[d], delta: round2(attitudes[d] - means[di]),
      })).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 3);
      // 2D coords from the centroid's two highest-variance dims (deterministic map)
      const coords = projectCoords(idxs, vectors, presentDims, means);
      return {
        id: `seg_${c + 1}`,
        name: nameSegment(signature),
        n: idxs.length,
        size_pct: round1((idxs.length / vectors.length) * 100),
        is_primary: false,
        attitudes,
        signature,
        coords,
        ...prof,
      };
    }).sort((a, b) => b.n - a.n);

    segments[0].is_primary = true; // largest segment = primary target (default)

    return {
      ...skeleton,
      n,
      posture: 'segmented',
      aggregate,
      segments,
      primary_segment_id: segments[0].id,
      segment_count: k,
      key_dimension: keyDimension,
      reason: null,
    };
  } catch (err) {
    return { ...skeleton, reason: 'Segmentation could not be computed; see raw responses.' };
  }
}

/* Behaviours / media / needs profile for a set of persona indices. */
function buildProfile(idxs, personas, presentDims, qs, byQ) {
  const personaIds = new Set(idxs.map((i) => personas[i][0]));
  const topFor = (kind, limit = 4) => {
    const out = [];
    for (const q of qs) {
      if (!q || q.kind !== kind) continue;
      const rows = (byQ.get(q.id) || []).filter((r) => personaIds.has(r.persona_id));
      if (!rows.length) continue;
      const base = new Set(rows.map((r) => r.persona_id)).size;
      const { shares: sh } = shares(distribution(rows), base);
      const top = Object.entries(sh).sort((a, b) => b[1].pct - a[1].pct).slice(0, 3)
        .map(([label, s]) => ({ label, pct: s.pct }));
      out.push({ question: q.text || q.id, top });
    }
    return out.slice(0, limit);
  };
  return {
    behaviours: topFor('behavioural'),
    media: topFor('media'),
    needs: topFor('needs'),
  };
}

function projectCoords(idxs, vectors, presentDims, means) {
  // two highest-variance dimensions overall → x,y of this segment's centroid,
  // recentred on the grand mean so the map spreads around the middle.
  const variances = presentDims.map((_, di) => {
    const m = means[di];
    return vectors.reduce((s, v) => s + (v[di] - m) ** 2, 0) / vectors.length;
  });
  const order = presentDims.map((_, i) => i).sort((a, b) => variances[b] - variances[a]);
  const [xi, yi] = [order[0], order[1] ?? order[0]];
  const cx = idxs.reduce((s, i) => s + vectors[i][xi], 0) / idxs.length;
  const cy = idxs.reduce((s, i) => s + vectors[i][yi], 0) / idxs.length;
  return { x: round2(cx - means[xi]), y: round2(cy - means[yi]), x_dim: presentDims[xi], y_dim: presentDims[yi] };
}

function nameSegment(signature) {
  // name from the top-1/2 distinctive dimensions and their direction.
  const hi = (s) => s.delta >= 0;
  const word = {
    price_sensitivity: ['Value-driven', 'Premium-comfortable'],
    novelty_seeking: ['Early adopters', 'Pragmatists'],
    brand_loyalty: ['Loyalists', 'Switchers'],
    convenience: ['Convenience-first', 'Effort-tolerant'],
    status: ['Status-seekers', 'Understated'],
    sustainability: ['Conscious', 'Indifferent'],
  };
  const top = signature[0];
  if (!top) return 'Segment';
  const primary = (word[top.dimension] || ['Segment', 'Segment'])[hi(top) ? 0 : 1];
  const second = signature[1];
  if (second && Math.abs(second.delta) >= 0.5) {
    const sub = (word[second.dimension] || ['', ''])[hi(second) ? 0 : 1];
    if (sub) return `${primary} · ${sub.toLowerCase()}`;
  }
  return primary;
}

module.exports = { computeAudienceProfiling, ATTITUDE_DIMENSIONS, DIM_LABELS, MIN_CLUSTER_N };
