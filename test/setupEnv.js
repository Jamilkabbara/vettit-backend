// Pass 42 A5 — prime env vars before any test file loads its
// transitive require chain. Some modules (supabase, anthropic)
// throw at module-load time if their env keys are missing, which
// breaks tests that don't actually exercise those modules but
// transitively require them.
//
// jest config (setupFiles in package.json) loads this once per
// worker, before any test file is required.
process.env.SUPABASE_URL         = process.env.SUPABASE_URL         || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-service-key';
process.env.SUPABASE_ANON_KEY    = process.env.SUPABASE_ANON_KEY    || 'test-anon-key';
process.env.ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY    || 'test-anthropic-key';
process.env.STRIPE_SECRET_KEY    = process.env.STRIPE_SECRET_KEY    || 'sk_test_dummy';
