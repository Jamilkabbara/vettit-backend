-- Pass 35 A8 — CRM lead capture verification + seed.
--
-- Pass 32 already wired the full pipeline:
--   1. Frontend LeadCaptureForm (vett-platform/src/components/marketing/
--      LeadCaptureForm.tsx) POSTs to /api/crm/lead.
--   2. Backend src/routes/crm.js inserts into crm_leads with
--      stage='new_lead' and source jsonb (page/cta/utm_*).
--   3. Re-engagement detected via email dedup; appends timestamped
--      note to existing row.
--   4. Admin CRM tab reads from /api/admin/crm (admin.js line 875+).
--
-- Production audit found crm_leads empty because no real waitlist
-- submissions had landed yet (3-user platform). Pass 35 A8 seeds 2
-- demo rows so the admin CRM tab has content on first load and the
-- stage-progression UI is exercisable.
--
-- Apply via apply_migration as `pass_35_a8_crm_leads_seed`.

INSERT INTO public.crm_leads (
  email, name, company, stage, source, notes
)
VALUES
  (
    'demo+pmf@vettit.ai',
    'Demo PMF Lead',
    'VETT Demo Co',
    'new_lead',
    '{"page":"dashboard_banner","cta":"Join waitlist","captured_at":"2026-05-08T00:00:00Z"}'::jsonb,
    'Pass 35 A8 seed — admin CRM tab content'
  ),
  (
    'demo+pricing@vettit.ai',
    'Demo Pricing Lead',
    'Aurora Coffee Co',
    'contacted',
    '{"page":"landing","cta":"Get early access","captured_at":"2026-05-08T00:00:00Z"}'::jsonb,
    'Pass 35 A8 seed — admin CRM tab content'
  );
