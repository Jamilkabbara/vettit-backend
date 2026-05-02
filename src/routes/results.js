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

    res.json({
      status: 'completed',
      mission: full,
      insights,
      aggregatedByQuestion,
      screeningFunnel: screeningFunnel || null,
      responses: (responses || []).slice(0, 500),
      responseCount: (responses || []).length,
    });
  } catch (err) { next(err); }
});

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

    await buildXLSX(pack, res);
    logger.info('XLSX exported', { missionId: req.params.missionId, userId: req.user.id });
  } catch (err) { next(err); }
});

// ─── GET /api/results/:missionId/export/raw ──────────────────
// JSON dump of everything — useful for data-science use cases.
router.get('/:missionId/export/raw', authenticate, async (req, res, next) => {
  try {
    const pack = await loadMissionForExport(req.params.missionId, req.user.id);
    if (!pack)      return res.status(404).json({ error: 'Mission not found' });
    if (pack.error) return res.status(400).json({ error: pack.error });

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
      insights:            pack.insights,
      aggregatedByQuestion: pack.aggregatedByQuestion,
      responses:           pack.responses,
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
      .select('id, title, user_id, targeting_brief, paid_at')
      .eq('id', missionId)
      .eq('user_id', userId)
      .single();

    if (error || !mission) return res.status(404).json({ error: 'Mission not found' });

    if (!mission.targeting_brief) {
      return res.status(202).json({ error: 'Targeting brief is still generating — try again in a minute.' });
    }

    const b = mission.targeting_brief;
    const dateStr = mission.paid_at
      ? new Date(mission.paid_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : new Date().toLocaleDateString();

    const meta    = b.meta_ads    || {};
    const google  = b.google_ads  || {};
    const linkedin = b.linkedin_ads || {};

    const md = `# Targeting Brief — ${mission.title}
_Generated by VETT AI · ${dateStr}_

## Ideal Customer Profile
${b.icp_summary || '_Not available_'}

---

## Meta Ads (Facebook / Instagram)

**Locations:** ${(meta.locations || []).join(', ') || '—'}
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
