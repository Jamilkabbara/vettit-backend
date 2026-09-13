# `src/db/` — what used to be here, and why it is gone

Three `.sql` files lived in this directory from April 2026 until 2026-09-13:
`migration.sql`, `migrations.sql` and `schema_v2.sql`. They were the original
bootstrap scripts for a much earlier version of the schema. **They have been
deleted.** Nothing executed them — no npm script, no `railway.json`
`startCommand`, no `readFileSync` anywhere in `src/` or `scripts/`. They were
loaded weapons sitting next to the trigger, and each one opened with a comment
telling the reader to paste it into the Supabase SQL Editor.

This is the same problem, and the same fix, as the eight local migration files
deleted from the frontend repo in vett-platform#132.

## Why a stale `.sql` file is dangerous rather than merely untidy

**Postgres ORs permissive RLS policies.** Adding a permissive policy next to a
hardened one does not tighten anything; it widens it to the union of the two.
So "run the old bootstrap to make sure the tables exist" does not re-assert an
old state, it grants whatever the old file granted **on top of** everything
that has been hardened since.

Everything below was checked against production on 2026-09-13 before deleting.

### `migrations.sql` — the dangerous one

| Statement | What it would have done to production |
|---|---|
| `CREATE OR REPLACE FUNCTION public.handle_new_user()` | **Broken every new signup.** The live function writes `email`, `full_name`, `first_name`, `last_name` and `avatar_url`, deriving names from OAuth `given_name` / `family_name` and the avatar from `avatar_url` / `picture`. The file's version writes `full_name` only. Signups would have kept working and silently stopped capturing everything else — which is what feeds the CRM. |
| `DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;` then `CREATE TRIGGER` | Re-pointed the auth trigger at that regressed function. |
| `CREATE POLICY "Anyone can view uploaded files" ON storage.objects FOR SELECT TO public` | **Public read over every uploaded file.** Live `storage.objects` has twelve policies and *not one* of them grants `public`: all are `authenticated` and own-scoped (`users_read_own_uploads`, `users_read_own_creatives`, `vettit_uploads: user can select own`, and an admin read). This line would have OR'd a world-readable SELECT across every customer creative. |
| `INSERT INTO storage.buckets (id, name, public) VALUES ('vettit-uploads', ..., true)` | `ON CONFLICT DO NOTHING`, so inert today — but it encodes `public: true` as the intended state, which is not the intended state. |
| 3 × `CREATE POLICY ... ON profiles` | No-ops. The live policy names are identical and the statements sit inside `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL`. |

### `schema_v2.sql`

`CREATE TABLE IF NOT EXISTS` throughout, so the table definitions are inert.
The policies are not. It would have added five permissive policies, including
`admin_all_missions ON public.missions FOR SELECT` and
`users_own_chats ON public.chat_sessions FOR ALL`. `public.missions` currently
has exactly four policies — `missions_select`, `missions_insert`,
`missions_update`, `missions_delete` — and a fifth permissive SELECT would be
OR'd with them, not intersected.

### `migration.sql`

Benign in content: `ADD COLUMN IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`
against `missions`, plus a trailing `SELECT` against `information_schema`.
Deleted anyway, because it carried the same "paste this into the SQL Editor"
instruction and because a directory with one safe bootstrap script and two
dangerous ones is a directory where the next person runs the wrong file.

## Where schema changes actually live

`vettit-backend/migrations/pass-NN/`, applied in order, each file carrying its
own dry run, rollback and verification notes in the header. That is the only
place a schema change belongs. Nothing in `src/db/` should ever be executable
SQL again.

The `.js` files still in this directory are application code and are unrelated
to any of the above:

- `supabase.js` — the client
- `missionSchema.js` / `missionsColumns.json` — the server-owned vs
  client-patchable column sets
- `fetchAllRows.js` / `fetchAllResponses.js` — the paging helpers that exist
  because PostgREST silently caps an unbounded read at 1000 rows and returns
  HTTP 206, which supabase-js does not surface
