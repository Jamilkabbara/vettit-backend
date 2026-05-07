-- Pass 30 B3 — Compare Concepts (sequential monadic) input columns.
-- Applied via apply_migration as `pass_30_b3_compare_inputs`.

ALTER TABLE missions ADD COLUMN IF NOT EXISTS concepts JSONB;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS comparison_methodology TEXT DEFAULT 'sequential_monadic';
ALTER TABLE missions ADD COLUMN IF NOT EXISTS rotation_strategy TEXT DEFAULT 'random';
