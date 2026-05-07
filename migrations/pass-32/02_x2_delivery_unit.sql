-- Pass 32 X2 — delivery_unit clarifies what was actually delivered.
-- Applied via apply_migration as `pass_32_x2_delivery_unit` and
-- `pass_32_x2_delivery_unit_trigger`.

ALTER TABLE missions ADD COLUMN IF NOT EXISTS delivery_unit TEXT DEFAULT 'respondent';

UPDATE missions SET delivery_unit = 'creative_asset'
WHERE goal_type = 'creative_attention';

-- BEFORE INSERT/UPDATE trigger keeps delivery_unit invariant tied to
-- goal_type so new CA missions are flagged 'creative_asset' even if
-- the client doesn't send the column.
CREATE OR REPLACE FUNCTION set_delivery_unit_from_goal()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.goal_type = 'creative_attention' THEN
    NEW.delivery_unit := 'creative_asset';
  ELSIF NEW.delivery_unit IS NULL THEN
    NEW.delivery_unit := 'respondent';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_missions_set_delivery_unit ON missions;
CREATE TRIGGER trg_missions_set_delivery_unit
BEFORE INSERT OR UPDATE OF goal_type ON missions
FOR EACH ROW
EXECUTE FUNCTION set_delivery_unit_from_goal();
