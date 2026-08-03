/**
 * Gitea webhook event types
 */

export interface WebhookEvent {
  action: string;
  issue?: {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    labels: { name: string }[];
    state: string;
    pull_request?: object; // Present (as object, not null) if the issue is actually a PR
  };
  pull_request?: {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    state: string;
    merged?: boolean;
    changed_files?: number;
    additions?: number;
    deletions?: number;
    head?: {
      ref: string;
      sha: string;
      repo?: {
        full_name: string;
      };
    };
    base?: {
      repo?: {
        full_name: string;
      };
    };
  };
  comment?: {
    body: string;
    user: { login: string };
  };
  repository: {
    owner: { login: string };
    name: string;
    full_name: string;
    html_url: string;
    default_branch: string;
  };
  sender: { login: string };
}
