const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const supabase = require('../db/supabase');

/**
 * GET /api/notifications
 *   ?unread=true   -> only unread
 *   ?limit=20
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const onlyUnread = req.query.unread === 'true';

    let q = supabase
      .from('notifications')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (onlyUnread) q = q.is('read_at', null);

    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

/**
 * GET /api/notifications/unread-count
 */
router.get('/unread-count', authenticate, async (req, res, next) => {
  try {
    const { count, error } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', req.user.id)
      .is('read_at', null);
    if (error) throw error;
    res.json({ count: count || 0 });
  } catch (err) { next(err); }
});

/**
 * POST /api/notifications/:id/read
 */
router.post('/:id/read', authenticate, async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

/**
 * POST /api/notifications/mark-all-read
 */
router.post('/mark-all-read', authenticate, async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', req.user.id)
      .is('read_at', null);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
