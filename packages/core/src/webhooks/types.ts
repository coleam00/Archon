export interface WebhookRule {
  id: string;
  codebase_id: string;
  path_slug: string;
  workflow_name: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface WebhookRuleWithCodebaseName extends WebhookRule {
  codebase_name: string;
}
