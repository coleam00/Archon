export const itemTextSchema = `
CREATE TABLE IF NOT EXISTS remote_agent_item_text_acceptances (
  project_key TEXT NOT NULL,
  item_key TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  accepted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_key, item_key)
);

CREATE TABLE IF NOT EXISTS remote_agent_item_text_requirements (
  item_id TEXT PRIMARY KEY REFERENCES remote_agent_items(id) ON DELETE CASCADE,
  requirement TEXT NOT NULL
);`;
