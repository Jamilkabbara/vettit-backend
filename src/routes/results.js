const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const supabase = require('../db/supabase');
const pollfishService = require('../services/pollfish');
const aiService = require('../services/claudeAI');
const emailService = require('../services/email');
const logger = require('../utils/logger');
const PDFDocument = require('pdfkit');

// GET /api/results/:missionId
router.get('/:missionId', authenticate, async (req, res, next) => {
  try {
    const { data: mission, error } = await supabase
      .from('missions')
      .select('*')
      .eq('id', req.params.missionId)
      .eq('user_id', req.user.id)
      .single();

    if (error || !mission) return res.status(404).json({ error: 'Mission not found' });
    if (mission.status === 'draft') return res.status(400).json({ error: 'Mission not launched yet' });

    // Return cached results if available
    if (mission.result_data && mission.ai_insights) {
      return res.json({ mission, results: mission.result_data, insights: mission.ai_insights });
    }

    // Poll Pollfish for status
    if (mission.pollfish_survey_id) {
      const pollfishStatus = await pollfishService.getSurveyStatus(mission.pollfish_survey_id);

      if (pollfishStatus.status !== 'completed') {
        return res.json({
          mission,
          status: 'in_progress',
          completedResponses: pollfishStatus.completedResponses,
          targetResponses: mission.respondent_count,
        });
      }

      // Fetch + store results
      const rawResults = await pollfishService.getSurveyResults(mission.pollfish_survey_id);
      const insights = await aiService.analyseResults({
        missionStatement: mission.mission_statement,
        questions: mission.questions || [],
        resultData: rawResults,
        targetingUsed: mission.targeting_config,
      });

      await supabase
        .from('missions')
        .update({
          status: 'completed',
          result_data: rawResults,
          ai_insights: insights,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', req.params.missionId);

      // Completion email
      const { data: { user } } = await supabase.auth.admin.getUserById(req.user.id);
      const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', req.user.id).single();
      await emailService.sendMissionCompletedEmail({
        to: user.email,
        name: profile?.full_name,
        missionStatement: mission.mission_statement,
        totalResponses: rawResults.totalResponses,
        missionId: mission.id,
      }).catch(e => logger.warn('Completion email failed', e));

      logger.info('Mission completed', { missionId: mission.id });
      return res.json({ mission: { ...mission, status: 'completed' }, results: rawResults, insights });
    }

    res.json({ mission, status: mission.status });
  } catch (err) {
    next(err);
  }
});

// GET /api/results/:missionId/status — lightweight poll for progress
router.get('/:missionId/status', authenticate, async (req, res, next) => {
  try {
    const { data: mission, error } = await supabase
      .from('missions')
      .select('id, status, respondent_count, pollfish_survey_id, completed_at')
      .eq('id', req.params.missionId)
      .eq('user_id', req.user.id)
      .single();

    if (error || !mission) return res.status(404).json({ error: 'Mission not found' });

    if (mission.status === 'completed') {
      return res.json({ status: 'completed', completedAt: mission.completed_at });
    }

    if (mission.pollfish_survey_id) {
      const pollfishStatus = await pollfishService.getSurveyStatus(mission.pollfish_survey_id);
      return res.json({
        status: pollfishStatus.status,
        completedResponses: pollfishStatus.completedResponses,
        targetResponses: mission.respondent_count,
        percentComplete: Math.round((pollfishStatus.completedResponses / mission.respondent_count) * 100),
      });
    }

    res.json({ status: mission.status });
  } catch (err) {
    next(err);
  }
});

// GET /api/results/:missionId/export/pdf
router.get('/:missionId/export/pdf', authenticate, async (req, res, next) => {
  try {
    const { data: mission, error } = await supabase
      .from('missions')
      .select('*')
      .eq('id', req.params.missionId)
      .eq('user_id', req.user.id)
      .single();

    if (error || !mission) return res.status(404).json({ error: 'Mission not found' });
    if (!mission.result_data) return res.status(400).json({ error: 'Results not ready yet' });

    const insights = mission.ai_insights || {};
    const results = mission.result_data;

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="vettit-report-${mission.id}.pdf"`);
    doc.pipe(res);

    // ── Cover ───────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 180).fill('#0B0C15');
    doc.fontSize(32).fillColor('#BEF264').text('VETTIT', 50, 50);
    doc.fontSize(13).fillColor('#ffffff').text('AI Market Research Report', 50, 95);
    doc.moveDown(4);

    doc.fontSize(16).fillColor('#111111').text(mission.mission_statement || 'Research Report', { width: 490 });
    doc.moveDown(0.5);
    doc.fontSize(11).fillColor('#555555')
      .text(`Respondents: ${results.totalResponses}  ·  Completion Rate: ${Math.round((results.completionRate || 0.94) * 100)}%  ·  ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`);
    doc.moveDown(2);

    // ── Executive Summary ───────────────────────────────────
    doc.fontSize(14).fillColor('#0B0C15').text('Executive Summary');
    doc.moveTo(50, doc.y + 4).lineTo(545, doc.y + 4).strokeColor('#BEF264').lineWidth(2).stroke();
    doc.moveDown(0.8);
    doc.fontSize(11).fillColor('#333333').text(insights.executiveSummary || 'Analysis not available.', { lineGap: 4 });
    doc.moveDown(1.5);

    // ── Key Findings ────────────────────────────────────────
    if (insights.keyFindings?.length) {
      doc.fontSize(14).fillColor('#0B0C15').text('Key Findings');
      doc.moveTo(50, doc.y + 4).lineTo(545, doc.y + 4).strokeColor('#BEF264').lineWidth(2).stroke();
      doc.moveDown(0.8);
      insights.keyFindings.forEach((f, i) => {
        doc.fontSize(11).fillColor('#333333').text(`${i + 1}.  ${f}`, { indent: 10, lineGap: 3 });
        doc.moveDown(0.4);
      });
      doc.moveDown(1);
    }

    // ── Question Results ────────────────────────────────────
    doc.addPage();
    doc.fontSize(14).fillColor('#0B0C15').text('Question-by-Question Results');
    doc.moveTo(50, doc.y + 4).lineTo(545, doc.y + 4).strokeColor('#BEF264').lineWidth(2).stroke();
    doc.moveDown(0.8);

    (mission.questions || []).forEach((q, i) => {
      const qResult = results.responses?.find(r => r.questionId === q.id);
      const qInsight = insights.questionInsights?.find(qi => qi.questionId === q.id);

      doc.fontSize(12).fillColor('#111111').text(`Q${i + 1}: ${q.text}`);
      doc.moveDown(0.3);

      if (qResult?.answers) {
        const total = Object.values(qResult.answers).reduce((s, v) => s + v, 0);
        Object.entries(qResult.answers).forEach(([answer, count]) => {
          const pct = total > 0 ? Math.round((count / total) * 100) : 0;
          // Bar visualization
          const barWidth = Math.round((pct / 100) * 200);
          doc.fontSize(10).fillColor('#555555').text(`  ${answer}`, { continued: true });
          doc.fillColor('#aaaaaa').text(`  ${count} responses  (${pct}%)`);
          doc.rect(doc.x, doc.y, barWidth, 6).fill('#6366F1');
          doc.rect(doc.x + barWidth, doc.y, 200 - barWidth, 6).fill('#eeeeee');
          doc.moveDown(0.8);
        });
      }

      if (qResult?.texts) {
        doc.fontSize(10).fillColor('#555555').text('  Open responses:');
        qResult.texts.slice(0, 3).forEach(t => {
          doc.fontSize(10).fillColor('#777777').text(`  "…${t.substring(0, 100)}"`, { indent: 10 });
        });
        doc.moveDown(0.3);
      }

      if (qInsight?.insight) {
        doc.roundedRect(50, doc.y, 495, 35, 4).fill('#f0f0ff');
        doc.fontSize(10).fillColor('#6366F1').text(`  ✦ ${qInsight.insight}`, 60, doc.y - 28, { width: 475 });
        doc.moveDown(0.8);
      }
      doc.moveDown(0.5);
    });

    // ── Recommendations ─────────────────────────────────────
    if (insights.recommendations?.length) {
      doc.addPage();
      doc.fontSize(14).fillColor('#0B0C15').text('Recommendations');
      doc.moveTo(50, doc.y + 4).lineTo(545, doc.y + 4).strokeColor('#BEF264').lineWidth(2).stroke();
      doc.moveDown(0.8);
      insights.recommendations.forEach((r, i) => {
        doc.fontSize(11).fillColor('#333333').text(`${i + 1}.  ${r}`, { indent: 10, lineGap: 3 });
        doc.moveDown(0.5);
      });
      doc.moveDown(1);
    }

    // ── Follow-Up Surveys ───────────────────────────────────
    if (insights.suggestedFollowUpSurveys?.length) {
      doc.fontSize(14).fillColor('#0B0C15').text('Recommended Follow-Up Research');
      doc.moveTo(50, doc.y + 4).lineTo(545, doc.y + 4).strokeColor('#BEF264').lineWidth(2).stroke();
      doc.moveDown(0.8);
      insights.suggestedFollowUpSurveys.forEach((s, i) => {
        doc.fontSize(12).fillColor('#111111').text(`${i + 1}. ${s.title}`);
        doc.fontSize(10).fillColor('#555555').text(`   ${s.description}`, { lineGap: 3 });
        doc.moveDown(0.6);
      });
    }

    // ── Footer ───────────────────────────────────────────────
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(8).fillColor('#aaaaaa')
        .text('Vettit · AI-Powered Market Research · vettit.ai · Dubai, UAE',
          50, doc.page.height - 40, { align: 'center', width: doc.page.width - 100 });
    }

    doc.end();
    logger.info('PDF exported', { missionId: mission.id });
  } catch (err) {
    next(err);
  }
});

// GET /api/results/:missionId/export/raw — JSON download
router.get('/:missionId/export/raw', authenticate, async (req, res, next) => {
  try {
    const { data: mission, error } = await supabase
      .from('missions')
      .select('result_data, ai_insights, mission_statement, questions, targeting_config, respondent_count')
      .eq('id', req.params.missionId)
      .eq('user_id', req.user.id)
      .single();

    if (error || !mission) return res.status(404).json({ error: 'Mission not found' });
    if (!mission.result_data) return res.status(400).json({ error: 'Results not ready yet' });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="vettit-raw-${req.params.missionId}.json"`);
    res.json({
      mission: {
        statement: mission.mission_statement,
        respondentCount: mission.respondent_count,
        targeting: mission.targeting_config,
        questions: mission.questions,
      },
      results: mission.result_data,
      insights: mission.ai_insights,
      exportedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
