-- WO#4 Phase 2 — the admin Costs "capacity" card called an RPC that was never
-- created (PGRST202: "Could not find the function public.pg_database_size(db)"),
-- which is why the card shipped with a hardcoded 15 MB placeholder. This creates
-- the missing wrapper so the card can show the REAL database size.
--
-- SECURITY: definer-owned, pinned search_path, and EXECUTE revoked from anon +
-- authenticated — only the service-role backend (admin router, behind
-- authenticate + adminOnly) can call it. Exposes a single number (total DB
-- size), no table data.
--
-- Apply in the Supabase SQL editor (owner-run).

create or replace function public.pg_database_size(db text)
returns bigint
language sql
security definer
set search_path = pg_catalog, public
as $$
  select pg_catalog.pg_database_size(db);
$$;

revoke execute on function public.pg_database_size(text) from public;
revoke execute on function public.pg_database_size(text) from anon;
revoke execute on function public.pg_database_size(text) from authenticated;
grant execute on function public.pg_database_size(text) to service_role;
