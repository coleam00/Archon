-- Add role column to agent registry
-- Allows agents to have a defined role in the team (e.g. 'Product Owner', 'Scrum Master', 'Developer')
ALTER TABLE archon_agent_registry ADD COLUMN IF NOT EXISTS role TEXT;
