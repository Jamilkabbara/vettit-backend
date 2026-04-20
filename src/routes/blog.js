const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');

/**
 * GET /api/blog — public list of published posts.
 *   ?tag=Pricing
 *   ?limit=20
 */
router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 24, 100);
    let q = supabase
      .from('blog_posts')
      .select('id, slug, title, excerpt, tag, emoji, published_at, views_count')
      .not('published_at', 'is', null)
      .order('published_at', { ascending: false })
      .limit(limit);
    if (req.query.tag) q = q.eq('tag', req.query.tag);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

/**
 * GET /api/blog/:slug — single post, increments views_count.
 */
router.get('/:slug', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('blog_posts')
      .select('*')
      .eq('slug', req.params.slug)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Post not found' });

    // Fire-and-forget view counter bump
    supabase.from('blog_posts')
      .update({ views_count: (data.views_count || 0) + 1 })
      .eq('id', data.id)
      .then(() => {}).catch(() => {});

    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;
