-- Add title and soft-delete support to conversations
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS title VARCHAR(255);

ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;
