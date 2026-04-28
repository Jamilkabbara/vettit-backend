-- =============================================================================
-- Pass 23 Bug 23.12 — backfill notification copy.
--
-- Pre-fix code wrote `${mission.title} results are ready` as the title which
-- looked ugly in the bell ("would travel superapp work globally results are
-- ready"). Templated copy splits clean title + body. Also standardise link
-- to /dashboard/:id (mission control) per Bug 23.12 spec.
--
-- notifications has no mission_id FK — extract the mission UUID from the
-- link via regex (handles both /results/:id and /results?missionId=:id
-- legacy formats) and JOIN missions on that. Idempotent: re-running won't
-- match rows that were already templated (title='Mission complete' doesn't
-- LIKE '% results are ready').
-- =============================================================================

UPDATE notifications n
SET
  title = 'Mission complete',
  body = 'Your "' ||
    CASE
      WHEN length(m.title) > 60 THEN substring(m.title, 1, 57) || '...'
      ELSE COALESCE(m.title, 'VETT mission')
    END
    || '" results are ready.',
  link = '/dashboard/' || m.id::text
FROM missions m
WHERE n.type = 'mission_complete'
  AND n.title LIKE '% results are ready'
  AND substring(n.link FROM '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')::uuid = m.id;

DO $$
DECLARE
  awkward_left int;
BEGIN
  SELECT COUNT(*) INTO awkward_left
    FROM notifications WHERE title LIKE '% results are ready';
  RAISE NOTICE 'Pass 23 B12 backfill: awkward_titles_remaining=% (expect 0)', awkward_left;
END $$;
