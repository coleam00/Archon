CREATE TABLE IF NOT EXISTS remote_agent_webhook_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codebase_id UUID NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
  path_slug TEXT,
  workflow_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE remote_agent_webhook_rules
  ADD COLUMN IF NOT EXISTS path_slug TEXT;

UPDATE remote_agent_webhook_rules
   SET path_slug = CONCAT('legacy-', SUBSTRING(MD5(id::text) FROM 1 FOR 12))
 WHERE path_slug IS NULL OR BTRIM(path_slug) = '';

ALTER TABLE remote_agent_webhook_rules
  ALTER COLUMN path_slug SET NOT NULL;

ALTER TABLE remote_agent_webhook_rules
  DROP COLUMN IF EXISTS provider;

ALTER TABLE remote_agent_webhook_rules
  DROP COLUMN IF EXISTS event_type;

CREATE INDEX IF NOT EXISTS idx_webhook_rules_codebase
  ON remote_agent_webhook_rules(codebase_id);

CREATE INDEX IF NOT EXISTS idx_webhook_rules_path_slug
  ON remote_agent_webhook_rules(path_slug);

DROP INDEX IF EXISTS idx_webhook_rules_provider_event;
DROP INDEX IF EXISTS idx_webhook_rules_active_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_rules_path_slug_unique
  ON remote_agent_webhook_rules(path_slug);
