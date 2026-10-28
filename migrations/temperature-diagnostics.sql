-- Additive migration. Existing users and temperature schedules are unchanged.
BEGIN;
CREATE TABLE IF NOT EXISTS "8slp_temperatureDiagnostics" (
  "id" uuid PRIMARY KEY,
  "email" varchar(255) NOT NULL REFERENCES "8slp_users"("email"),
  "started_at" timestamptz NOT NULL,
  "diagnostic" jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS "8slp_diagnostics_user_started_idx"
  ON "8slp_temperatureDiagnostics" ("email", "started_at");
CREATE INDEX IF NOT EXISTS "8slp_diagnostics_started_idx"
  ON "8slp_temperatureDiagnostics" ("started_at");
COMMIT;
