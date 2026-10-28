-- Additive only: NULL retains the automatic start two hours before wake-up.
-- Existing schedules are not updated by this migration.
BEGIN;
ALTER TABLE "8slp_userTemperatureProfiles"
  ADD COLUMN IF NOT EXISTS "finalStageStartTime" time;
COMMIT;
