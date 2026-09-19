-- A short, agent-maintained summary of what a chat is for and where it got to.
--
-- brief_updated_at exists so the UI can say how old the summary is: a summary
-- you cannot date is one you will wrongly trust.
--
-- brief_pinned records that a human edited it. The agent stops overwriting a
-- pinned summary on its own, so a user's words are never silently replaced.
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS brief TEXT;
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS brief_updated_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS brief_pinned BOOLEAN DEFAULT FALSE;
