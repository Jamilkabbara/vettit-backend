const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');

/**
 * PUBLIC blog API.
 *
 * SECURITY NOTE — READ BEFORE EDITING
 * -----------------------------------
 * `supabase` here is the SERVICE-KEY client (src/db/supabase.js), so RLS is
 * BYPASSED on every query in this file. The row-level policies that protect
 * `blog_posts` everywhere else do not protect these routes:
 *
 *   blog_posts_anon_published_read     USING (published = true)
 *   blog_posts_authenticated_full      USING (published = true
 *                                             OR author_id = auth.uid()
 *                                             OR is_admin_user(auth.uid()))
 *
 * Every query below must therefore re-state that gate itself. `published` is
 * the authoritative condition, not `published_at`: it is NOT NULL DEFAULT
 * false (fail-closed) and it is the exact column both RLS policies test.
 * `published_at` is nullable metadata with no default, so a draft carrying a
 * scheduled date would satisfy an `IS NOT NULL` test while still being a
 * draft. The list route used to test exactly that weaker condition.
 *
 * The frontend does NOT use these routes - BlogPage.tsx and BlogPostPage.tsx
 * query Supabase directly with the anon key and are covered by RLS. This file
 * is a bare public surface with no such backstop.
 */

/** Columns safe to expose publicly. Never `*`. */
const PUBLIC_LIST_COLUMNS = 'id, slug, title, excerpt, tag, emoji, cover_image_url, published_at, views_count';
/**
 * Post view adds the body. Deliberately EXCLUDED, and each for a reason:
 *   author_id          - internal user id
 *   source_mission_ids - which customer missions a case study was built from.
 *                        This is the case-study provenance trail; publishing
 *                        it would leak the very association the consent model
 *                        exists to control.
 *   auto_generated     - internal provenance (and DEFAULT true, so it is
 *                        misleading on hand-written posts)
 *   published          - the gate itself; a public reader learns nothing from it
 *   created_at / updated_at - internal timestamps
 */
const PUBLIC_POST_COLUMNS = `${PUBLIC_LIST_COLUMNS}, body_markdown`;

/**
 * GET /api/blog — public list of published posts.
 *   ?tag=Pricing
 *   ?limit=20
 */
router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 24, 100);
    let q = supabase
      .from('blog_posts')
      .select(PUBLIC_LIST_COLUMNS)
      // Was `.not('published_at','is',null)` — a weaker, non-matching gate.
      .eq('published', true)
      .order('published_at', { ascending: false })
      .limit(limit);
    if (req.query.tag) q = q.eq('tag', req.query.tag);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

/**
 * GET /api/blog/:slug — single published post, increments views_count.
 *
 * An unpublished slug and an unknown slug both return the SAME 404 with the
 * same body, and neither bumps a counter, so the endpoint cannot be used as
 * an oracle to confirm that a draft exists under a guessed slug.
 */
router.get('/:slug', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('blog_posts')
      .select(PUBLIC_POST_COLUMNS)
      .eq('slug', req.params.slug)
      .eq('published', true)
      .maybeSingle();
    // maybeSingle, not single: `single()` treats "no row" as an error, which
    // conflates "not found" with a real query failure.
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Post not found' });

    // Fire-and-forget view counter bump. Scoped to published rows as well, so
    // a row unpublished between the read and this write is not counted.
    supabase.from('blog_posts')
      .update({ views_count: (data.views_count || 0) + 1 })
      .eq('id', data.id)
      .eq('published', true)
      .then(() => {}).catch(() => {});

    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;
