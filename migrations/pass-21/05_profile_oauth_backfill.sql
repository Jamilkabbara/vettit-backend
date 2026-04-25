-- Pass 21 Bug 10 — Profile name/avatar backfill from OAuth metadata.
--
-- Symptom: users who signed up via Google OAuth (or who linked Apple/Google
-- identities post-signup) had profiles.full_name / first_name / last_name /
-- avatar_url left null, even though auth.users.raw_user_meta_data carried
-- the OAuth payload. The Profile UI rendered "kabbarajamil@gmail.com"
-- instead of "Jamil Kabbara".
--
-- Root cause: the existing handle_new_user() trigger only reads
--   raw_user_meta_data ->> 'full_name'
-- which:
--   1. misses Google's `name`, `given_name`, `family_name`, `picture`
--   2. never touches first_name / last_name / avatar_url
--   3. fires once at the original auth.users INSERT — by then a row
--      created via plain email signup has empty metadata, even if the
--      same user later links Apple/Google and the metadata is enriched.
--
-- Fix has two parts:
--   (A) Replace handle_new_user() with a hardened version that reads all
--       common provider shapes and populates first_name / last_name /
--       avatar_url too. Idempotent (ON CONFLICT (id) DO NOTHING).
--   (B) One-shot backfill: for every existing profile, COALESCE over the
--       *current* raw_user_meta_data so identity-linking that happened
--       after signup is captured. COALESCE on the profile column is
--       deliberate — never overwrite a value the user already edited.
--
-- Forensic snapshot pre-fix (live DB):
--   3 users total (1 google, 2 email-with-OAuth-linked-metadata)
--   1 with name in metadata but profiles.full_name NULL  ← Jamil (Apple-linked)
--   2 with picture in metadata but profiles.avatar_url NULL  ← Jamil + Nourhan

-- ─────────────────────────────────────────────────────────────────────────
-- (A) Hardened trigger
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  meta        jsonb := COALESCE(new.raw_user_meta_data, '{}'::jsonb);
  full_name   text;
  given       text := NULLIF(meta ->> 'given_name', '');
  family      text := NULLIF(meta ->> 'family_name', '');
  avatar      text := NULLIF(COALESCE(meta ->> 'avatar_url', meta ->> 'picture'), '');
  first_n     text;
  last_n      text;
BEGIN
  full_name := NULLIF(COALESCE(
    meta ->> 'full_name',
    meta ->> 'name',
    NULLIF(TRIM(CONCAT_WS(' ', given, family)), '')
  ), '');

  -- Best-effort split for first/last when the provider only gave us a
  -- single 'full_name' (Google's `given_name`/`family_name` is preferred).
  first_n := COALESCE(given, NULLIF(SPLIT_PART(full_name, ' ', 1), ''));
  IF family IS NOT NULL THEN
    last_n := family;
  ELSIF full_name IS NOT NULL AND POSITION(' ' IN full_name) > 0 THEN
    last_n := NULLIF(TRIM(SUBSTRING(full_name FROM POSITION(' ' IN full_name) + 1)), '');
  END IF;

  INSERT INTO public.profiles (id, email, full_name, first_name, last_name, avatar_url)
  VALUES (new.id, new.email, full_name, first_n, last_n, avatar)
  ON CONFLICT (id) DO NOTHING;

  RETURN new;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- (B) One-shot backfill for existing rows.
--     COALESCE on the profile column first → never overwrites user edits.
-- ─────────────────────────────────────────────────────────────────────────
WITH src AS (
  SELECT
    u.id,
    u.email AS u_email,
    NULLIF(COALESCE(
      u.raw_user_meta_data ->> 'full_name',
      u.raw_user_meta_data ->> 'name',
      NULLIF(TRIM(CONCAT_WS(' ',
        u.raw_user_meta_data ->> 'given_name',
        u.raw_user_meta_data ->> 'family_name')), '')
    ), '') AS oauth_full_name,
    NULLIF(u.raw_user_meta_data ->> 'given_name', '')  AS oauth_given,
    NULLIF(u.raw_user_meta_data ->> 'family_name', '') AS oauth_family,
    NULLIF(COALESCE(
      u.raw_user_meta_data ->> 'avatar_url',
      u.raw_user_meta_data ->> 'picture'
    ), '') AS oauth_avatar
  FROM auth.users u
)
UPDATE public.profiles p
SET
  email      = COALESCE(p.email, src.u_email),
  full_name  = COALESCE(p.full_name, src.oauth_full_name),
  first_name = COALESCE(
    p.first_name,
    src.oauth_given,
    CASE WHEN src.oauth_full_name IS NOT NULL
         THEN NULLIF(SPLIT_PART(src.oauth_full_name, ' ', 1), '')
    END
  ),
  last_name  = COALESCE(
    p.last_name,
    src.oauth_family,
    CASE WHEN src.oauth_full_name IS NOT NULL AND POSITION(' ' IN src.oauth_full_name) > 0
         THEN NULLIF(TRIM(SUBSTRING(src.oauth_full_name FROM POSITION(' ' IN src.oauth_full_name) + 1)), '')
    END
  ),
  avatar_url = COALESCE(p.avatar_url, src.oauth_avatar)
FROM src
WHERE p.id = src.id
  AND (
       (p.full_name  IS NULL AND src.oauth_full_name IS NOT NULL)
    OR (p.first_name IS NULL AND (src.oauth_given IS NOT NULL OR src.oauth_full_name IS NOT NULL))
    OR (p.last_name  IS NULL AND (src.oauth_family IS NOT NULL OR src.oauth_full_name LIKE '% %'))
    OR (p.avatar_url IS NULL AND src.oauth_avatar IS NOT NULL)
    OR (p.email      IS NULL AND src.u_email      IS NOT NULL)
  );
