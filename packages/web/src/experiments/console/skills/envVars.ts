import { requestJson } from '../lib/http';

/**
 * Per-project environment variables.
 *
 * The server intentionally never returns values — only keys — so the UI can
 * never accidentally surface a secret. To rotate a key the user sets a new
 * value via `setEnvVar`; the existing value is overwritten server-side.
 */

interface ListEnvVarsResponse {
  keys: string[];
}

export async function listEnvVarKeys(projectId: string): Promise<string[]> {
  const res = await requestJson<ListEnvVarsResponse>(
    `/api/codebases/${encodeURIComponent(projectId)}/env`
  );
  return res.keys;
}

export async function setEnvVar(projectId: string, key: string, value: string): Promise<void> {
  await requestJson<{ success: boolean }>(`/api/codebases/${encodeURIComponent(projectId)}/env`, {
    method: 'PUT',
    body: JSON.stringify({ key, value }),
  });
}

export async function deleteEnvVar(projectId: string, key: string): Promise<void> {
  await requestJson<{ success: boolean }>(
    `/api/codebases/${encodeURIComponent(projectId)}/env/${encodeURIComponent(key)}`,
    { method: 'DELETE' }
  );
}
