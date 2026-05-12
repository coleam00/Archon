-- Migration: Drop deprecated command templates table
-- Command templates were replaced by file-based commands in .archon/commands
--
-- BREAKING CHANGE: If you have existing templates, export them before upgrading:
--   SELECT name, content FROM remote_agent_command_templates;
-- Then save each as .archon/commands/<name>.md in your repositories.
--
-- After this migration, use /command-invoke <name> instead of /<name>

DROP TABLE IF EXISTS remote_agent_command_templates;
DROP INDEX IF EXISTS idx_remote_agent_command_templates_name;
