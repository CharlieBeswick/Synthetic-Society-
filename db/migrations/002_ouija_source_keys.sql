ALTER TABLE ouija_audit ADD COLUMN IF NOT EXISTS source_key text;

CREATE UNIQUE INDEX IF NOT EXISTS ouija_audit_source_key ON ouija_audit (source_key);
