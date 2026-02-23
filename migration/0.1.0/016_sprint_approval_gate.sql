-- Sprint Approval Gate Migration
-- Adds 'ready_for_kickoff' status to the sprint lifecycle.
--
-- New lifecycle:
--   planning → ready_for_kickoff → active → completed | cancelled
--
-- The ready_for_kickoff status is the PO approval gate: only the Product Owner
-- (agent name: 'user') can transition a sprint from ready_for_kickoff to active.
-- The enforcement lives in sprint_service.py, not in this schema.

-- Add new enum value between planning and active (idempotent in PG 9.1+)
ALTER TYPE sprint_status ADD VALUE IF NOT EXISTS 'ready_for_kickoff' BEFORE 'active';

-- Self-record
INSERT INTO archon_migrations (version, migration_name)
VALUES ('016', 'sprint_approval_gate')
ON CONFLICT (version, migration_name) DO NOTHING;
