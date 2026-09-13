-- Pass 55 - any signed-in user can delete or rewrite every published blog post.
--
-- NOT APPLIED. Held for owner approval.
--
-- WHAT IS TRUE ON PRODUCTION RIGHT NOW
--   policyname : blog_posts_authenticated_full
--   permissive : PERMISSIVE   roles: {authenticated}   cmd: ALL
--   USING      : (published = true)
--                OR (author_id = (SELECT auth.uid()))
--                OR is_admin_user((SELECT auth.uid()))
--   WITH CHECK : is_admin_user((SELECT auth.uid()))
--                OR (author_id = (SELECT auth.uid()))
--
-- and `authenticated` holds DELETE, INSERT, SELECT, UPDATE, TRUNCATE,
-- REFERENCES, TRIGGER on the table.
--
-- THE DEFECT
-- A single policy with cmd = ALL applies its USING clause to SELECT, UPDATE
-- and DELETE alike. DELETE consults ONLY the USING clause - there is no WITH
-- CHECK on a delete, because there is no new row to check. USING matches on
-- `published = true`. Therefore every published post is deletable by any
-- account that can sign up.
--
-- UPDATE is exploitable too, and the WITH CHECK does not save it: USING lets
-- the attacker reach the row via `published = true`, and the same statement
-- can set author_id to their own uid, which satisfies WITH CHECK. So they can
-- rewrite the body of any published post and walk away owning it.
--
-- The WITH CHECK clause is the tell. Someone wrote the correct ownership rule
-- and put it only where it governs the shape of the NEW row, leaving the
-- question of WHICH ROWS MAY BE TOUCHED answered by `published = true` - a
-- read predicate doing a write predicate's job.
--
-- 3 published posts are live today, so the blast radius is the whole blog.
--
-- THE FIX
-- Split the one ALL policy into four per-command policies. The read predicate
-- keeps `published = true`, because that is what it is for. The three write
-- predicates drop it and require ownership or admin on BOTH sides.
--
-- INSERT is STAFF ONLY, per the owner's decision of 2026-09-13. Today any
-- authenticated user can create a blog post; the probe confirmed it live
-- ("INSERT a new post as a non-staff signed-in user -> row created"). The blog
-- is a marketing surface, so authorship belongs to staff. is_admin_user() is
-- the same predicate the rest of this table already trusts.
--
-- Postgres ORs permissive policies, so the old policy MUST be dropped in the
-- same transaction, not merely joined by stricter siblings.
--
-- Verification after applying:
--   SELECT policyname, cmd, qual, with_check FROM pg_policies
--    WHERE tablename = 'blog_posts' ORDER BY policyname;
--   -- no policy with cmd = 'ALL'; no write policy whose qual mentions
--   -- `published`.
--
-- Positive control, on a throwaway post, with a normal signed-in session that
-- does not own it:
--   DELETE  -> 0 rows affected (before: the row is gone)
--   UPDATE  -> 0 rows affected (before: the row is rewritten and reassigned)
--   SELECT  -> still returns the published post (must not regress)
-- and the same three as the author, which must all still succeed.
--
-- ROLLBACK:
--   DROP the four policies below and recreate blog_posts_authenticated_full
--   exactly as quoted at the top of this file.

BEGIN;

DROP POLICY IF EXISTS blog_posts_authenticated_full ON public.blog_posts;

-- READ. Unchanged in effect: a signed-in user sees published posts, their own
-- drafts, and (as admin) everything.
CREATE POLICY blog_posts_auth_select ON public.blog_posts
  FOR SELECT TO authenticated
  USING (
    published = true
    OR author_id = (SELECT auth.uid())
    OR is_admin_user((SELECT auth.uid()))
  );

-- CREATE. Staff only. The old WITH CHECK also allowed `author_id = auth.uid()`,
-- which let any signed-in account publish to the company blog.
CREATE POLICY blog_posts_auth_insert ON public.blog_posts
  FOR INSERT TO authenticated
  WITH CHECK (is_admin_user((SELECT auth.uid())));

-- EDIT. `published` is gone from both sides: reaching the row now requires
-- owning it, and the row may not be reassigned to someone else on the way out.
CREATE POLICY blog_posts_auth_update ON public.blog_posts
  FOR UPDATE TO authenticated
  USING (
    author_id = (SELECT auth.uid())
    OR is_admin_user((SELECT auth.uid()))
  )
  WITH CHECK (
    author_id = (SELECT auth.uid())
    OR is_admin_user((SELECT auth.uid()))
  );

-- DELETE. The hole. USING is the only gate a delete has, so it carries the
-- ownership rule itself.
CREATE POLICY blog_posts_auth_delete ON public.blog_posts
  FOR DELETE TO authenticated
  USING (
    author_id = (SELECT auth.uid())
    OR is_admin_user((SELECT auth.uid()))
  );

-- Nothing needs TRUNCATE, and RLS does not gate it - it is a table-level
-- privilege, so a policy cannot stop it. Revoke it outright.
REVOKE TRUNCATE ON public.blog_posts FROM authenticated, anon;

COMMIT;
