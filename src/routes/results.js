/**
 * VETT — Results & Export routes.
 * All data comes from the synthetic pipeline (mission_responses + mission.insights).
 * No external survey vendor APIs.
 */

const express = require('express');
const router  = express.Router();

const { authenticate } = require('../middleware/auth');
const supabase = require('../db/supabase');
const logger   = require('../utils/logger');

const { loadMissionForExport } = require('../services/exports/shared');
// Pass 25 Phase 0: PDF rebuilt on Puppeteer + Handlebars (was pdfkit).
// See docs/PDF_EXPORT_AUDIT.md. Old pdfkit module retained for one deploy
// behind PDF_LEGACY=1 in case rollback is needed; deleted next merge.
const { buildPDF: buildPDFv2 } = require('../services/exports/pdf-v2');
const { buildPDF: buildPDFLegacy } = require('../services/exports/pdf');
const buildPDF = process.env.PDF_LEGACY === '1' ? buildPDFLegacy : buildPDFv2;
const { buildPPTX } = require('../services/exports/pptx');
const { buildXLSX } = require('../services/exports/xlsx');
// Pass 27.5 B — CA-specific XLSX exporter (6-sheet template).
const { buildCreativeAttentionXLSX } = require('../services/exports/xlsx_creative_attention');

// ─── GET /api/results/:missionId ─────────────────────────────
// Bug 7 (Pass 20): this endpoint now serves three response shapes,
// keyed off mission.status so the SPA can render the right UI without
// needing to hit a separate /status endpoint:
//
//   • completed                     → full results payload (unchanged)
//   • paid | processing             → 200 { status:'processing', progress:{collected,target,percent} }
//   • failed                        → 200 { status:'failed', error:<reason> }
//   • draft | pending_payment       → 400 (user shouldn't be here yet)
//
// `paid` is included alongside `processing` because there's a brief
// (~1–10s) window between the webhook acking the payment and the
// background worker claiming the mission. Without this, a user who
// just paid would see a "Results not ready" error during that gap.
//
// Pass 21 Bug 19: missions.failure_reason is now a real top-level column,
// populated by runMission's fatal handler with err.message (≤ 500 chars).
// We prefer that over the legacy mission_assets.analysis_error.message,
// which is only ever populated by the creative-attention pipeline.
router.get('/:missionId', authenticate, async (req, res, next) => {
  try {
    const missionId = req.params.missionId;

    // Cheap status check first — avoids loading responses + aggregating
    // for missions that aren't ready.
    const { data: mission, error: mErr } = await supabase
      .from('missions')
      .select('id, status, respondent_count, questions, mission_assets, failure_reason')
      .eq('id', missionId)
      .eq('user_id', req.user.id)
      .single();

    if (mErr || !mission) return res.status(404).json({ error: 'Mission not found' });

    // In-flight states: return progress envelope.
    if (mission.status === 'paid' || mission.status === 'processing') {
      const { count } = await supabase
        .from('mission_responses')
        .select('persona_id', { count: 'exact', head: true })
        .eq('mission_id', missionId);
      const collected = count || 0;
      const questionCount = Array.isArray(mission.questions) ? mission.questions.length : 1;
      const target = (mission.respondent_count || 1) * Math.max(1, questionCount);
      const percent = Math.min(100, Math.round((collected / (target || 1)) * 100));
      return res.json({
        status: 'processing',
        progress: { collected, target, percent },
      });
    }

    // Fatal failure: return 200 with reason so SPA can render error UI
    // without having to parse fetch exceptions.
    // Pass 21 Bug 19: prefer the new top-level failure_reason column,
    // fall back to the legacy creative-attention JSON path, then to a
    // generic string for old failed rows that pre-date the column.
    if (mission.status === 'failed') {
      const reason = mission.failure_reason
        || mission.mission_assets?.analysis_error?.message
        || 'Mission could not complete. Please contact support.';
      return res.json({ status: 'failed', error: reason });
    }

    // Pre-payment states — user shouldn't be on /results yet.
    if (mission.status !== 'completed') {
      return res.status(400).json({ error: 'Results not ready yet — mission is not complete' });
    }

    // Completed: full payload.
    const pack = await loadMissionForExport(missionId, req.user.id);
    if (!pack) return res.status(404).json({ error: 'Mission not found' });
    if (pack.error) return res.status(400).json({ error: pack.error });

    const { mission: full, responses, insights, aggregatedByQuestion, screeningFunnel } = pack;

    // Pass 27.5 C — filter aggregation. AND composition across the 7 axes.
    // Empty filter result returns 200 with zero counts (not 404). Lift mode
    // returns paired exposed/control aggregations so the page can render
    // delta_pp metrics. Backwards-compatible: omitting query params returns
    // the existing shape plus new metadata fields.
    const filters = parseFilters(req.query);
    const filtered = applyFilters(responses || [], pack.mission, filters);
    const lift_mode = filters.exposure === 'lift';

    // Pass 28 C — for brand_lift missions with filters applied (or
    // lift mode requested), compute a filtered brand_lift_results
    // shape so the score dial / funnel / channel table actually
    // re-render with the slice. Non-brand_lift missions and unfiltered
    // brand_lift requests pass through the canonical
    // mission.brand_lift_results JSONB.
    const isBrandLift = pack.mission.goal_type === 'brand_lift';
    const baseBlr = pack.mission.brand_lift_results || null;
    const shouldRecomputeBlr = isBrandLift && baseBlr && (filters.applied || lift_mode);
    const filteredBlr = shouldRecomputeBlr
      ? computeFilteredBrandLiftResults({
          blr: baseBlr,
          filtered,
          questions: pack.mission.questions || [],
          lift_mode,
          filters,
        })
      : null;

    let payload;
    if (lift_mode) {
      const exposedSet = filtered.filter(r => r.exposure_status === 'exposed');
      const controlSet = filtered.filter(r => r.exposure_status === 'control');
      payload = {
        status: 'completed',
        mission: full,
        insights,
        aggregatedByQuestion: pairAggregates(exposedSet, controlSet, pack.mission.questions || []),
        screeningFunnel: screeningFunnel || null,
        responses: filtered.slice(0, 500),
        responseCount: filtered.length,
        filters_applied: filters,
        filtered_respondent_count: distinctPersonas(filtered).size,
        total_respondent_count: distinctPersonas(responses || []).size,
        lift_mode: true,
        brand_lift_results: filteredBlr,
      };
    } else {
      const filteredAgg = filters.applied
        ? recomputeAggregates(filtered, pack.mission.questions || [])
        : aggregatedByQuestion;
      payload = {
        status: 'completed',
        mission: full,
        insights,
        aggregatedByQuestion: filteredAgg,
        screeningFunnel: screeningFunnel || null,
        responses: filtered.slice(0, 500),
        responseCount: filtered.length,
        filters_applied: filters,
        filtered_respondent_count: distinctPersonas(filtered).size,
        total_respondent_count: distinctPersonas(responses || []).size,
        lift_mode: false,
        brand_lift_results: filteredBlr,
      };
    }
    res.json(payload);
  } catch (err) { next(err); }
});

// ─── Filter helpers (Pass 27.5 C) ─────────────────────────────────
// All filter axes parsed from req.query as CSV. Returned object carries
// `applied` flag so the consumer knows whether the result differs from
// the unfiltered set.
function parseFilters(q) {
  const csv = (s) => (typeof s === 'string' && s.length > 0 ? s.split(',').map(x => x.trim()).filter(Boolean) : []);
  const exposure = typeof q.exposure === 'string' && ['exposed','control','lift','all'].includes(q.exposure)
    ? q.exposure
    : 'all';
  const wave = q.wave != null && q.wave !== '' && !Number.isNaN(Number(q.wave))
    ? Number(q.wave)
    : null;
  const f = {
    markets: csv(q.markets),
    channels: csv(q.channels),
    categories: csv(q.categories),
    genders: csv(q.genders),
    ages: csv(q.ages),
    exposure,
    wave,
  };
  f.applied = f.markets.length > 0 || f.channels.length > 0 || f.categories.length > 0
    || f.genders.length > 0 || f.ages.length > 0 || f.exposure !== 'all' || f.wave !== null;
  return f;
}

function ageBucket(age) {
  const a = Number(age);
  if (!Number.isFinite(a)) return null;
  if (a < 25) return '18-24';
  if (a < 35) return '25-34';
  if (a < 45) return '35-44';
  if (a < 55) return '45-54';
  if (a < 65) return '55-64';
  return '65+';
}

function applyFilters(responses, mission, f) {
  if (!f.applied) return responses;
  return responses.filter(r => {
    const profile = r.persona_profile || {};
    if (f.markets.length > 0) {
      const country = profile.country || profile.country_code;
      if (!country || !f.markets.includes(country)) return false;
    }
    if (f.genders.length > 0) {
      const g = (profile.gender || '').toLowerCase();
      const norm = g === 'm' ? 'male' : g === 'f' ? 'female' : g.replace(/[ -]/g, '_');
      if (!f.genders.map(x => x.toLowerCase()).includes(norm)) return false;
    }
    if (f.ages.length > 0) {
      const bucket = ageBucket(profile.age);
      if (!bucket || !f.ages.includes(bucket)) return false;
    }
    if (f.exposure === 'exposed' || f.exposure === 'control') {
      if (r.exposure_status !== f.exposure) return false;
    }
    return true;
  });
}

function distinctPersonas(rows) {
  const s = new Set();
  for (const r of rows) if (r.persona_id) s.add(r.persona_id);
  return s;
}

function recomputeAggregates(rows, questions) {
  const { aggregate } = require('../services/ai/insights');
  return aggregate(rows, questions);
}

function pairAggregates(exposedRows, controlRows, questions) {
  const e = recomputeAggregates(exposedRows, questions);
  const c = recomputeAggregates(controlRows, questions);
  const out = {};
  for (const q of questions) {
    out[q.id] = { exposed: e[q.id] || null, control: c[q.id] || null };
  }
  return out;
}

// ─── Pass 28 C — filtered brand_lift_results aggregator ────────
// Recomputes the brand_lift_results shape (score + funnel + channels +
// geography + waves) for an arbitrary respondent slice. Anything that
// cannot be recomputed from response-level data (competitors,
// recommendations, AI synthesis) passes through from the canonical
// pre-aggregated mission.brand_lift_results.
//
// Funnel value heuristic: per stage, average normalized values
// (rating averages 1-5 → 0-100 by *20; NPS 0-10 → 0-100 by *10;
// single/opinion/multi → top option's share %).
//
// Score: weighted blend of brand_favorability (0.20),
// brand_consideration (0.30), purchase_intent (0.30), nps (0.20).
function stageValueFromAgg(qAgg, q) {
  if (!qAgg || !q) return null;
  const type = q.type || qAgg.type;
  if (type === 'rating') {
    const avg = qAgg.average;
    if (typeof avg !== 'number') return null;
    if (q.funnel_stage === 'nps') return Math.round(avg * 10);
    return Math.round(avg * 20);
  }
  if (type === 'single' || type === 'opinion') {
    const dist = qAgg.distribution || {};
    const total = Object.values(dist).reduce((s, n) => s + (Number(n) || 0), 0);
    if (total === 0) return null;
    const top = Object.entries(dist).sort((a, b) => b[1] - a[1])[0];
    return Math.round(((Number(top[1]) || 0) / total) * 100);
  }
  if (type === 'multi') {
    const dist = qAgg.distribution || {};
    const n = qAgg.n_respondents || qAgg.n || 0;
    if (n === 0) return null;
    const top = Object.entries(dist).sort((a, b) => b[1] - a[1])[0];
    return Math.round(((Number(top[1]) || 0) / n) * 100);
  }
  return null;
}

function buildFunnelFromAgg(agg, questions) {
  const STAGES = [
    { id: 'unaided_ad_recall',       label: 'Unaided ad recall' },
    { id: 'aided_ad_recall',         label: 'Aided ad recall' },
    { id: 'unaided_brand_awareness', label: 'Unaided awareness' },
    { id: 'aided_brand_awareness',   label: 'Aided awareness' },
    { id: 'brand_familiarity',       label: 'Familiarity' },
    { id: 'brand_favorability',      label: 'Favorability' },
    { id: 'brand_consideration',     label: 'Consideration' },
    { id: 'purchase_intent',         label: 'Purchase intent' },
    { id: 'nps',                     label: 'NPS' },
  ];
  const out = [];
  for (const stage of STAGES) {
    const qsForStage = (questions || []).filter(q => q.funnel_stage === stage.id);
    if (qsForStage.length === 0) continue;
    const values = qsForStage
      .map(q => stageValueFromAgg(agg[q.id], q))
      .filter(v => v != null);
    if (values.length === 0) continue;
    const value = Math.round(values.reduce((s, v) => s + v, 0) / values.length);
    out.push({ id: stage.id, label: stage.label, value });
  }
  return out;
}

function computeScoreFromFunnel(funnel) {
  const weights = {
    brand_favorability: 0.20,
    brand_consideration: 0.30,
    purchase_intent: 0.30,
    nps: 0.20,
  };
  let total = 0;
  let used = 0;
  for (const stage of funnel) {
    const w = weights[stage.id];
    if (typeof w === 'number' && typeof stage.value === 'number') {
      total += stage.value * w;
      used += w;
    }
  }
  if (used === 0) {
    if (funnel.length === 0) return null;
    return Math.round(funnel.reduce((s, f) => s + (f.value || 0), 0) / funnel.length);
  }
  return Math.round(total / used);
}

function liftStages(exposedFunnel, controlFunnel) {
  const cIdx = new Map(controlFunnel.map(s => [s.id, s]));
  return exposedFunnel.map(s => {
    const c = cIdx.get(s.id);
    const exposed = s.value;
    const control = c ? c.value : 0;
    return {
      id: s.id,
      label: s.label,
      value: exposed,
      control,
      delta_pp: exposed - control,
    };
  });
}

function intersect(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const set = new Set(b);
  return a.some(x => set.has(x));
}

function filterChannels(channels, f) {
  if (!Array.isArray(channels)) return [];
  let out = channels;
  if (f.channels && f.channels.length > 0) out = out.filter(c => f.channels.includes(c.id));
  if (f.categories && f.categories.length > 0) out = out.filter(c => f.categories.includes(c.category));
  if (f.markets && f.markets.length > 0) {
    out = out.filter(c => {
      const mks = Array.isArray(c.markets) ? c.markets : [];
      return mks.length === 0 || intersect(mks, f.markets);
    });
  }
  return out;
}

function filterGeography(geo, f) {
  if (!Array.isArray(geo)) return [];
  if (!f.markets || f.markets.length === 0) return geo;
  return geo.filter(row => f.markets.includes(row.region));
}

function filterWaves(waves, f) {
  if (!Array.isArray(waves)) return [];
  if (f.wave == null) return waves;
  return waves.filter(w => Number(w.wave_index ?? w.label) === Number(f.wave) || w.label === String(f.wave));
}

function computeFilteredBrandLiftResults({ blr, filtered, questions, lift_mode, filters }) {
  if (!blr) return null;
  const fallback = { ...blr };
  if (lift_mode) {
    const exposedRows = filtered.filter(r => r.exposure_status === 'exposed');
    const controlRows = filtered.filter(r => r.exposure_status === 'control');
    const eAgg = recomputeAggregates(exposedRows, questions);
    const cAgg = recomputeAggregates(controlRows, questions);
    const eFunnel = buildFunnelFromAgg(eAgg, questions);
    const cFunnel = buildFunnelFromAgg(cAgg, questions);
    const funnel = liftStages(eFunnel, cFunnel);
    const score = computeScoreFromFunnel(eFunnel);
    return {
      ...fallback,
      score: score != null ? score : fallback.score,
      funnel: funnel.length > 0 ? funnel : fallback.funnel,
      channels: filterChannels(fallback.channels, filters),
      geography: filterGeography(fallback.geography, filters),
      waves: filterWaves(fallback.waves, filters),
      lift_mode: true,
    };
  }
  const agg = recomputeAggregates(filtered, questions);
  const funnel = buildFunnelFromAgg(agg, questions);
  const score = computeScoreFromFunnel(funnel);
  return {
    ...fallback,
    score: score != null ? score : fallback.score,
    funnel: funnel.length > 0 ? funnel : fallback.funnel,
    channels: filterChannels(fallback.channels, filters),
    geography: filterGeography(fallback.geography, filters),
    waves: filterWaves(fallback.waves, filters),
    lift_mode: false,
  };
}

// ─── GET /api/results/:missionId/status ──────────────────────
// Lightweight poll — used by the progress UI while a mission is running.
router.get('/:missionId/status', authenticate, async (req, res, next) => {
  try {
    const { data: mission, error } = await supabase
      .from('missions')
      .select('id, status, respondent_count, started_at, completed_at')
      .eq('id', req.params.missionId)
      .eq('user_id', req.user.id)
      .single();

    if (error || !mission) return res.status(404).json({ error: 'Mission not found' });

    // Count rows collected so far — drives the progress bar.
    let collected = 0;
    if (mission.status === 'processing' || mission.status === 'completed') {
      const { count } = await supabase
        .from('mission_responses')
        .select('persona_id', { count: 'exact', head: true })
        .eq('mission_id', mission.id);
      collected = count || 0;
    }

    const target = (mission.respondent_count || 1) * Math.max(1, /* questions */ 1);
    res.json({
      status:      mission.status,
      startedAt:   mission.started_at,
      completedAt: mission.completed_at,
      collected,
      target:      mission.respondent_count,
      percent:     Math.min(100, Math.round((collected / (target || 1)) * 100)),
    });
  } catch (err) { next(err); }
});

// ─── GET /api/results/:missionId/export/pdf ──────────────────
router.get('/:missionId/export/pdf', authenticate, async (req, res, next) => {
  try {
    const pack = await loadMissionForExport(req.params.missionId, req.user.id);
    if (!pack)        return res.status(404).json({ error: 'Mission not found' });
    if (pack.error)   return res.status(400).json({ error: pack.error });

    await buildPDF(pack, res);
    logger.info('PDF exported', { missionId: req.params.missionId, userId: req.user.id });
  } catch (err) { next(err); }
});

// ─── GET /api/results/:missionId/export/pptx ─────────────────
router.get('/:missionId/export/pptx', authenticate, async (req, res, next) => {
  try {
    const pack = await loadMissionForExport(req.params.missionId, req.user.id);
    if (!pack)      return res.status(404).json({ error: 'Mission not found' });
    if (pack.error) return res.status(400).json({ error: pack.error });

    await buildPPTX(pack, res);
    logger.info('PPTX exported', { missionId: req.params.missionId, userId: req.user.id });
  } catch (err) { next(err); }
});

// ─── GET /api/results/:missionId/export/xlsx ─────────────────
router.get('/:missionId/export/xlsx', authenticate, async (req, res, next) => {
  try {
    const pack = await loadMissionForExport(req.params.missionId, req.user.id);
    if (!pack)      return res.status(404).json({ error: 'Mission not found' });
    if (pack.error) return res.status(400).json({ error: pack.error });

    // Pass 27.5 B — CA missions get the 6-sheet creative_attention template.
    // brand_lift + general_research stay on the existing buildXLSX path.
    if (pack.mission?.goal_type === 'creative_attention') {
      await buildCreativeAttentionXLSX(pack, res);
    } else {
      await buildXLSX(pack, res);
    }
    logger.info('XLSX exported', { missionId: req.params.missionId, userId: req.user.id, goal_type: pack.mission?.goal_type });
  } catch (err) { next(err); }
});

// ─── GET /api/results/:missionId/brand-lift-benchmarks ────────
// Pass 25 Phase 1F — AI benchmark service. Cached per (industry, region,
// channel mix hash, audience segment, kpi template) for 30 days.
router.get('/:missionId/brand-lift-benchmarks', authenticate, async (req, res, next) => {
  try {
    const { data: mission, error } = await supabase
      .from('missions')
      .select('id, user_id, goal_type, targeting, campaign_channels, brand_lift_template')
      .eq('id', req.params.missionId)
      .eq('user_id', req.user.id)
      .single();
    if (error || !mission) return res.status(404).json({ error: 'Mission not found' });
    if (mission.goal_type !== 'brand_lift') {
      return res.status(400).json({ error: 'not_a_brand_lift_mission' });
    }
    const { getBenchmarks } = require('../services/brandLiftBenchmarks');
    const channels = Array.isArray(mission.campaign_channels)
      ? mission.campaign_channels.map(c => (typeof c === 'string' ? c : c?.id)).filter(Boolean)
      : [];
    const result = await getBenchmarks({
      industry: req.query.industry || 'general',
      region: mission.targeting?.geography || { countries: [], cities: [] },
      channels,
      audience: req.query.audience || null,
      kpi_template: mission.brand_lift_template || 'funnel_overview',
      missionId: mission.id,
      userId: req.user.id,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// ─── GET /api/results/:missionId/export/raw ──────────────────
// JSON dump of everything — useful for data-science use cases.
router.get('/:missionId/export/raw', authenticate, async (req, res, next) => {
  try {
    const pack = await loadMissionForExport(req.params.missionId, req.user.id);
    if (!pack)      return res.status(404).json({ error: 'Mission not found' });
    if (pack.error) return res.status(400).json({ error: pack.error });

    // Pass 25 Phase 0.1 Bug B + Pass 26 dead-content cleanup — tag screener
    // per-question insights with is_screener_insight: true AND, when the AI
    // returned tautological prose for a 100%-qualified screener, replace
    // headline/body with the sample-composition note used by PDF/PPTX. Keeps
    // every consumer aligned on the same content for screener questions.
    const { isScreener, getSampleCompositionNote } = require('../services/exports/screenerInsights');
    const taggedInsights = pack.insights ? { ...pack.insights } : {};
    if (Array.isArray(taggedInsights.per_question_insights)) {
      const qById = {};
      for (const q of (pack.mission.questions || [])) qById[q.id] = q;
      const sm = pack.sampleMetrics || {};
      const fullyQualified = (Number(sm.completed) || 0) === (Number(sm.total_respondents) || 0)
        && (Number(sm.total_respondents) || 0) > 0;
      taggedInsights.per_question_insights = taggedInsights.per_question_insights.map(pi => {
        const q = qById[pi?.question_id];
        if (!q || !isScreener(q)) return pi;
        if (!fullyQualified) return { ...pi, is_screener_insight: true };
        const note = getSampleCompositionNote(q, pack.aggregatedByQuestion?.[q.id], sm);
        return {
          question_id: pi.question_id,
          headline: note.headline,
          body: note.body,
          significance: pi.significance || 'low',
          is_screener_insight: true,
        };
      });
    }

    // Pass 25 Phase 0.1 Bug H + A — surface schema drift and option overlap as
    // top-level _integrity_warnings (never blocks the export).
    const { buildIntegrityWarnings } = require('../services/exports/integrity');
    const integrityWarnings = buildIntegrityWarnings(pack.mission, pack.aggregatedByQuestion);

    // Pass 25 Phase 0.1 Minor 1 — distinct mission_completed vs report_generated
    const { getReportMetadata } = require('../services/exports/reportMetadata');
    const reportMeta = getReportMetadata(pack.mission);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition',
      `attachment; filename="vett-raw-${req.params.missionId}.json"`);
    res.json({
      mission: {
        id:               pack.mission.id,
        title:            pack.mission.title,
        brief:            pack.mission.brief || pack.mission.mission_statement,
        goal_type:        pack.mission.goal_type,
        respondent_count: pack.mission.respondent_count,
        targeting:        pack.mission.targeting,
        questions:        pack.mission.questions,
        completed_at:     pack.mission.completed_at,
      },
      insights:            taggedInsights,
      aggregatedByQuestion: pack.aggregatedByQuestion,
      responses:           pack.responses,
      _integrity_warnings: integrityWarnings,
      mission_completed_at: reportMeta.mission_completed_at,
      report_generated_at:  reportMeta.report_generated_at,
      exportedAt:          new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// ─── GET /api/results/:missionId/export/audience-brief ───────
// Short marketing-ready audience profile built from the persona set.
router.get('/:missionId/export/audience-brief', authenticate, async (req, res, next) => {
  try {
    const pack = await loadMissionForExport(req.params.missionId, req.user.id);
    if (!pack)      return res.status(404).json({ error: 'Mission not found' });
    if (pack.error) return res.status(400).json({ error: pack.error });

    // Deduplicate by persona_id — each persona answers every question so it's repeated in rows.
    const bypid = {};
    for (const r of (pack.responses || [])) {
      if (!bypid[r.persona_id]) bypid[r.persona_id] = r.persona_profile || {};
    }
    const personas = Object.values(bypid);

    // Tally
    const tally = (key) => {
      const counts = {};
      for (const p of personas) {
        const v = p[key];
        if (!v) continue;
        counts[v] = (counts[v] || 0) + 1;
      }
      return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => ({ value: k, count: v, pct: Math.round((v / personas.length) * 100) }));
    };

    res.json({
      missionId:  pack.mission.id,
      title:      pack.mission.title,
      audienceSize: personas.length,
      demographics: {
        age:        tally('age'),
        gender:     tally('gender'),
        country:    tally('country') .concat(tally('country_code')),
        city:       tally('city'),
        occupation: tally('occupation').concat(tally('role')),
        income:     tally('income'),
      },
      executive_summary: pack.insights.executive_summary,
      exportedAt: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// ─── GET /api/results/:missionId/export/targeting-brief ──────
// AI-generated paid-media targeting brief (Meta / Google / LinkedIn).
// The brief is generated once when the mission completes and stored in
// missions.targeting_brief.  Returns 202 while still generating.
router.get('/:missionId/export/targeting-brief', authenticate, async (req, res, next) => {
  try {
    const { missionId } = req.params;
    const userId = req.user.id;

    const { data: mission, error } = await supabase
      .from('missions')
      .select('id, title, user_id, targeting, targeting_brief, paid_at, completed_at')
      .eq('id', missionId)
      .eq('user_id', userId)
      .single();

    if (error || !mission) return res.status(404).json({ error: 'Mission not found' });

    if (!mission.targeting_brief) {
      return res.status(202).json({ error: 'Targeting brief is still generating — try again in a minute.' });
    }

    const b = mission.targeting_brief;
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const completedDateStr = mission.completed_at
      ? new Date(mission.completed_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : '—';

    const meta    = b.meta_ads    || {};
    const google  = b.google_ads  || {};
    const linkedin = b.linkedin_ads || {};

    // Pass 25 Phase 0.1 Bug I — countries come from mission.targeting.geography.countries
    // (canonical research scope), NOT from targeting_brief.meta_ads.locations (which is
    // an AI-narrowed media-buy recommendation that silently dropped countries).
    const { countryNames } = require('../services/exports/iso3166');
    const researchCountryCodes = mission.targeting?.geography?.countries || [];
    const researchCountryNames = countryNames(researchCountryCodes);
    const aiPriorityLocations = Array.isArray(meta.locations) ? meta.locations : [];

    const locationsBlock = researchCountryNames.length
      ? researchCountryNames.join(', ')
      : '—';
    const priorityBlock = aiPriorityLocations.length && aiPriorityLocations.length < researchCountryNames.length
      ? `\n\n**AI-recommended priority markets** (subset of research scope): ${aiPriorityLocations.join(', ')}`
      : '';

    const md = `# Targeting Brief — ${mission.title}
_Mission completed: ${completedDateStr} · Report generated: ${dateStr}_

## Ideal Customer Profile
${b.icp_summary || '_Not available_'}

---

## Meta Ads (Facebook / Instagram)

**Locations** (research scope, ${researchCountryNames.length} countries): ${locationsBlock}${priorityBlock}
**Age range:** ${meta.age_range || '—'}
**Gender:** ${meta.gender || 'All'}

**Interests:**
${(meta.interests || []).map(i => `- ${i}`).join('\n') || '- —'}

**Behaviors:**
${(meta.behaviors || []).map(i => `- ${i}`).join('\n') || '- —'}

**Exclusions:**
${(meta.exclusions || []).map(i => `- ${i}`).join('\n') || '- —'}

---

## Google Ads

**Keywords:**
${(google.keywords || []).map(k => `- ${k}`).join('\n') || '- —'}

**Negative keywords:**
${(google.negative_keywords || []).map(k => `- ${k}`).join('\n') || '- —'}

**Audiences:**
${(google.audiences || []).map(a => `- ${a}`).join('\n') || '- —'}

---

## LinkedIn Ads

**Industries:** ${(linkedin.industries || []).join(', ') || '—'}
**Job titles:** ${(linkedin.job_titles || []).join(', ') || '—'}
**Seniorities:** ${(linkedin.seniorities || []).join(', ') || '—'}
**Job functions:** ${(linkedin.job_functions || []).join(', ') || '—'}
**Company sizes:** ${(linkedin.company_sizes || []).join(', ') || '—'}

---

## Lookalike Audience Strategy
${b.lookalike_seed || '_Not available_'}

---

## Recommended Ad Copy Angles
${(b.ad_copy_angles || []).map((a, i) => `${i + 1}. ${a}`).join('\n\n') || '_Not available_'}

---

_Generated by VETT AI market research. Paste targeting specs directly into your ad platform._
`;

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="VETT-TargetingBrief-${mission.id.slice(0, 8).toUpperCase()}.md"`);
    res.send(md);
  } catch (err) { next(err); }
});

/**
 * Pass 22 Bug 22.14 — GET /api/results/:missionId/reasoning?question_id=...&response_value=...
 *
 * Returns up to N persona_response_reasoning rows for a given mission+question
 * filtered by response_value. Powers the click-through "why did this persona
 * answer X?" modal on ResultsPage.
 *
 * The mission ownership check happens via the existing /api/results scope
 * (authenticate middleware + RLS policy on persona_response_reasoning that
 * scopes to mission owner or admin).
 */
router.get('/:missionId/reasoning', require('../middleware/auth').authenticate, async (req, res, next) => {
  try {
    const { missionId } = req.params;
    const { question_id, response_value } = req.query;
    const limit = Math.max(1, Math.min(20, parseInt(req.query.limit, 10) || 5));

    if (!question_id) return res.status(400).json({ error: 'question_id required' });

    // Ownership / admin check via missions table — service_role read here
    // since persona_response_reasoning RLS uses authenticated; this admin
    // route is gated by the authenticate middleware already.
    const { data: mission, error: mErr } = await supabase
      .from('missions').select('user_id').eq('id', missionId).maybeSingle();
    if (mErr || !mission) return res.status(404).json({ error: 'Mission not found' });
    const isOwner = mission.user_id === req.user.id;
    const isAdmin = req.user.email === (process.env.ADMIN_EMAIL || 'kabbarajamil@gmail.com');
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Forbidden' });

    let q = supabase
      .from('persona_response_reasoning')
      .select('persona_id, response_value, reasoning_text, created_at')
      .eq('mission_id', missionId)
      .eq('question_id', question_id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (typeof response_value === 'string' && response_value.length > 0) {
      q = q.eq('response_value', response_value);
    }

    const { data, error } = await q;
    if (error) throw error;
    res.json({ rows: data || [], count: (data || []).length });
  } catch (err) { next(err); }
});

module.exports = router;
