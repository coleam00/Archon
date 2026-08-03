/**
 * Server-health surface. Two consumers share the one `K.health` cache entry:
 * `useIsDocker` (gates the `Open in IDE` vscode:// affordance) and the Settings
 * SystemPanel (full status grid). The docker default stays `true` (hide the
 * button) until health resolves — matches the old UI and avoids flashing a broken
 * link on first paint inside Docker.
 */

import { ideUri } from '@/lib/ide-uri';
import { useEntity, type EntityView } from '../store/cache';
import { K } from '../store/keys';
import { getHealth, type HealthResponse } from '../skills/settings';

export type { HealthResponse };

export function useHealth(): EntityView<HealthResponse> {
  return useEntity<HealthResponse>(K.health, getHealth);
}

export function useIsDocker(): boolean {
  const { data } = useHealth();
  return data?.is_docker ?? true;
}

/** Server-environment hints needed to build a working vscode:// URI. */
export interface IdeEnv {
  is_wsl?: boolean;
  wsl_distro?: string;
}

export function useIdeEnv(): IdeEnv {
  const { data } = useHealth();
  return { is_wsl: data?.is_wsl, wsl_distro: data?.wsl_distro };
}

/** Open a host path in the user's editor via the vscode:// scheme. */
export function openInIde(workingPath: string, env?: IdeEnv): void {
  window.open(ideUri(workingPath, env), '_blank');
}
