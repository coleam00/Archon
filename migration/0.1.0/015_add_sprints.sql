-- Sprint Model Migration
-- Adds archon_sprints table and sprint_id FK on archon_tasks

-- Idempotent sprint_status enum
DO $$ BEGIN
    CREATE TYPE sprint_status AS ENUM ('planning', 'active', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Sprints table
CREATE TABLE IF NOT EXISTS archon_sprints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES archon_projects(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  goal TEXT,
  status sprint_status DEFAULT 'planning' NOT NULL,
  start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_archon_sprints_project_id ON archon_sprints(project_id);
CREATE INDEX IF NOT EXISTS idx_archon_sprints_status ON archon_sprints(status);

-- Add sprint_id FK to tasks
ALTER TABLE archon_tasks ADD COLUMN IF NOT EXISTS sprint_id UUID REFERENCES archon_sprints(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_archon_tasks_sprint_id ON archon_tasks(sprint_id);

-- updated_at trigger (reuses existing update_updated_at_column function)
DROP TRIGGER IF EXISTS update_archon_sprints_updated_at ON archon_sprints;
CREATE TRIGGER update_archon_sprints_updated_at
    BEFORE UPDATE ON archon_sprints
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS (same pattern as other archon tables)
ALTER TABLE archon_sprints ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access" ON archon_sprints;
CREATE POLICY "Service role full access" ON archon_sprints FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS "Authenticated read" ON archon_sprints;
CREATE POLICY "Authenticated read" ON archon_sprints FOR SELECT TO authenticated USING (true);

-- Self-record
INSERT INTO archon_migrations (version, migration_name) VALUES ('015', 'add_sprints')
ON CONFLICT (version, migration_name) DO NOTHING;
