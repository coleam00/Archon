-- Add a user-chosen color label to conversations.
--
-- Purely a visual label for scanning a project's chat list: the server never
-- interprets it. NULL means no color, which is the default for every chat.
ALTER TABLE remote_agent_conversations
  ADD COLUMN IF NOT EXISTS color VARCHAR(20);
