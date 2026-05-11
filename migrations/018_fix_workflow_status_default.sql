-- Fix workflow_runs.status default to match SQLite and actual code flow
-- Version: 18.0
-- Description: The executor creates workflow runs as 'pending' then explicitly
--   sets them to 'running'. Migration 008 incorrectly set DEFAULT 'running'.
--   SQLite adapter already uses DEFAULT 'pending'. This aligns PostgreSQL.

ALTER TABLE remote_agent_workflow_runs
  ALTER COLUMN status SET DEFAULT 'pending';
