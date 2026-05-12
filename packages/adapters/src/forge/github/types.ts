export interface WebhookEvent {
  action: 'opened' | 'closed' | 'created' | 'edited' | 'reopened' | 'labeled' | (string & {});
  issue?: {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    labels: { name: string }[];
    state: 'open' | 'closed';
    pull_request?: { url: string }; // Present if the issue is actually a PR
  };
  pull_request?: {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    state: 'open' | 'closed';
    merged?: boolean;
    changed_files?: number;
    additions?: number;
    deletions?: number;
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
