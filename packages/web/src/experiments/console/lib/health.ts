/**
 * Server-health surface. Currently only used for the Docker check so we
 * know whether to render the `Open in IDE` (vscode://) affordance. The
 * default is `true` (hide the button) until we hear otherwise — matches
 * the old UI's safer default and prevents flashing a broken link on first
 * paint inside Docker.
 */

import { useEntity } from '../store/cache';
import { requestJson } from './http';

interface HealthResponse {
  is_docker?: boolean;
}

const HEALTH_KEY = 'health';

export function useIsDocker(): boolean {
  const { data } = useEntity<HealthResponse>(HEALTH_KEY, () =>
    requestJson<HealthResponse>('/api/health')
  );
  return data?.is_docker ?? true;
}

/** Open a host path in the user's editor via the vscode:// scheme. */
export function openInIde(workingPath: string): void {
  // Normalise backslashes for Windows paths the same way the old UI does.
  const normalised = workingPath.replace(/\\/g, '/');
  window.open(`vscode://file/${normalised}`, '_blank');
}
