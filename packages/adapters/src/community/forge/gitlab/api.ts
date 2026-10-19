import type { GitLabClient } from './types';

/** One GitLab REST v4 call; a non-2xx answer throws with its status and body. */
export async function gitlabApi<T>(
  client: GitLabClient,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${client.gitlabUrl}/api/v4${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      'PRIVATE-TOKEN': client.token,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `GitLab API ${method} ${path}: ${String(response.status)} ${response.statusText} - ${text}`
    );
  }
  return response.json() as Promise<T>;
}
