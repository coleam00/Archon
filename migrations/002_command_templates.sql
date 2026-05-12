-- Remote Coding Agent - Command Templates
-- Version: 2.0
-- Description: Global command templates table

CREATE TABLE remote_agent_command_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_remote_agent_command_templates_name ON remote_agent_command_templates(name);
