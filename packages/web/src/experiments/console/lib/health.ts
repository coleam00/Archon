/**
 * Server-health surface. Currently only used for the Docker check so we
 * know whether to render the `Open in IDE` (vscode://) affordance. The
 * default is `true` (hide the button) until we hear otherwise — matches
 * the old UI's safer default and prevents flashing a broken link on first
 * paint inside Docker.
 */

import { ideUri } from '@/lib/ide-uri';
import { useEntity } from '../store/cache';
import { requestJson } from './http';

interface HealthResponse {
  is_docker?: boolean;
  is_wsl?: boolean;
  wsl_distro?: string;
}

const HEALTH_KEY = 'health';

export function useIsDocker(): boolean {
  const { data } = useEntity<HealthResponse>(HEALTH_KEY, () =>
    requestJson<HealthResponse>('/api/health')
  );
  return data?.is_docker ?? true;
}

/** Server-environment hints needed to build a working vscode:// URI. */
export interface IdeEnv {
  is_wsl?: boolean;
  wsl_distro?: string;
}

export function useIdeEnv(): IdeEnv {
  const { data } = useEntity<HealthResponse>(HEALTH_KEY, () =>
    requestJson<HealthResponse>('/api/health')
  );
  return { is_wsl: data?.is_wsl, wsl_distro: data?.wsl_distro };
}

/** Open a host path in the user's editor via the vscode:// scheme. */
export function openInIde(workingPath: string, env?: IdeEnv): void {
  window.open(ideUri(workingPath, env), '_blank');
}
