-- Add context_summary to conversations for /compact session compression
-- Stores AI-generated summary of conversation context for session continuity

ALTER TABLE remote_agent_conversations
ADD COLUMN IF NOT EXISTS context_summary TEXT;
