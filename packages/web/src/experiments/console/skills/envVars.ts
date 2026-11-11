import { requestJson } from '../lib/http';

/**
 * Per-project environment variables.
 *
 * The server intentionally never returns values — only keys — so the UI can
 * never accidentally surface a secret. To rotate a key the user sets a new
 * value via `setEnvVar`; the existing value is overwritten server-side.
 */

export async function listEnvVarKeys(projectId: string): Promise<string[]> {
  const res = await requestJson('/api/codebases/{id}/env', 'get', { params: { id: projectId } });
  return res.keys;
}

export async function setEnvVar(projectId: string, key: string, value: string): Promise<void> {
  await requestJson('/api/codebases/{id}/env', 'put', {
    params: { id: projectId },
    body: { key, value },
  });
}

export async function deleteEnvVar(projectId: string, key: string): Promise<void> {
  await requestJson('/api/codebases/{id}/env/{key}', 'delete', {
    params: { id: projectId, key },
  });
}
