const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const pollfishService = require('../services/pollfish');
const supabase = require('../db/supabase');

// GET /api/pollfish/status/:missionId — check survey progress
router.get('/status/:missionId', authenticate, async (req, res, next) => {
  try {
    const { data: mission } = await supabase
      .from('missions')
      .select('pollfish_survey_id, respondent_count, status')
      .eq('id', req.params.missionId)
      .eq('user_id', req.user.id)
      .single();

    if (!mission) return res.status(404).json({ error: 'Mission not found' });
    if (!mission.pollfish_survey_id) return res.json({ status: 'pending', progress: 0 });

    const pollfishStatus = await pollfishService.getSurveyStatus(mission.pollfish_survey_id);
    const progress = Math.min(
      Math.round((pollfishStatus.completedResponses / mission.respondent_count) * 100),
      100
    );

    res.json({ ...pollfishStatus, progress });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
