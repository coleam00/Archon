-- Project Phase Migration (v0.5.0)
-- Adds BMAD lifecycle phase to archon_projects.
--
-- Phase lifecycle:
--   analysis → planning → solutioning → implementation

ALTER TABLE archon_projects
  ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'analysis'
  CHECK (phase IN ('analysis', 'planning', 'solutioning', 'implementation'));
