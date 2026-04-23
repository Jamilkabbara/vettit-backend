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
const { buildPDF }  = require('../services/exports/pdf');
const { buildPPTX } = require('../services/exports/pptx');
const { buildXLSX } = require('../services/exports/xlsx');

// ─── GET /api/results/:missionId ─────────────────────────────
// Returns the full payload needed by the Results view: mission, insights,
// per-question aggregates, and the raw responses (capped for over-the-wire sanity).
router.get('/:missionId', authenticate, async (req, res, next) => {
  try {
    const pack = await loadMissionForExport(req.params.missionId, req.user.id);
    if (!pack) return res.status(404).json({ error: 'Mission not found' });
    if (pack.error) return res.status(400).json({ error: pack.error });

    const { mission, responses, insights, aggregatedByQuestion, screeningFunnel } = pack;

    res.json({
      mission,
      insights,
      aggregatedByQuestion,
      screeningFunnel: screeningFunnel || null,
      // Cap to 500 rows in the REST payload; the full set is always reachable via /export/xlsx
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

    buildPDF(pack, res);
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

module.exports = router;
