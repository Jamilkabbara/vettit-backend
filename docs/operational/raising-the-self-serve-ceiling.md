# Raising the self-serve respondent ceiling

The self-serve ceiling is enforced in **two places that cannot see each other**.
Changing one without the other silently breaks the product. Read this before
touching `MAX_SELF_SERVE_RESPONDENTS`.

## The two enforcement points

**1. Application (env-overridable, runtime)**

`src/utils/pricingEngine.js`:

```js
const MAX_SELF_SERVE_RESPONDENTS = Number(process.env.MAX_SELF_SERVE_RESPONDENTS || 1250);
```

`validateMissionPricing` rejects anything above this and routes it to a custom
quote. Because it reads an env var, this limit can be changed on Railway with no
deploy and no code review.

**2. Database (frozen, migration-only)**

`migrations/pass-51/01_missions_respondent_count_floors_check.sql`, applied
2026-09-06:

```sql
CONSTRAINT missions_respondent_count_range_chk
  CHECK (respondent_count IS NULL OR (respondent_count >= 1 AND respondent_count <= 1250)) NOT VALID
```

A CHECK constraint cannot read an env var, so **1250 is hard-coded here**.

## What goes wrong

Raise `MAX_SELF_SERVE_RESPONDENTS` to, say, 2000 on Railway and the application
will happily price and accept a 1600-respondent mission. The database will then
refuse the INSERT with a constraint violation.

The failure is worse than it sounds because of where it lands: the main UI path
inserts the mission row directly with supabase-js from the browser
(`MissionSetupPage.tsx`), so the customer hits a raw Postgres error at the end
of setup, after they have done all the work. The constraint becomes the binding
limit and the env var becomes a lie.

## The procedure

To raise the ceiling to N:

1. Write a migration that drops and re-adds `missions_respondent_count_range_chk`
   with the new N. Use `NOT VALID` again unless you have separately dealt with
   every historical row.
2. Apply it to production and verify with:
   ```sql
   SELECT conname, convalidated, pg_get_constraintdef(oid)
   FROM pg_constraint
   WHERE conrelid = 'public.missions'::regclass AND conname = 'missions_respondent_count_range_chk';
   ```
3. Only then set `MAX_SELF_SERVE_RESPONDENTS=N` on Railway.

Order matters. Widen the database first, then the application. Doing it the
other way round leaves a window where the app accepts missions the database
rejects.

To lower the ceiling, reverse the order: application first, then the database,
so the window is one where the database is more permissive than the app rather
than less.

## What already guards this, and what does not

`test/db_respondent_floor_constraints.test.js` reads **both** the SQL file and
the pricing engine's default and fails if they disagree. That catches someone
editing the constant in code without touching the migration.

It does **not** catch an env override, because a test cannot see Railway's
environment. There is no automated protection against that path. This document
is the protection.

## Related floors

The same migration also freezes two per-goal floors, with the same caveat:

| floor | value | source constant |
|---|---|---|
| brand_lift minimum | 100 | `BRAND_LIFT_MIN_RESPONDENTS` |
| creative_attention minimum | 10 | `CA_MIN_RESPONDENTS` |

Neither is currently env-overridable, so they only drift if someone edits the
constant without the migration, which the test above does catch.
