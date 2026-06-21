/**
 * Server-health surface. Two consumers share the one `K.health` cache entry:
 * `useIsDocker` (gates the `Open in IDE` vscode:// affordance) and the Settings
 * SystemPanel (full status grid). The docker default stays `true` (hide the
 * button) until health resolves — matches the old UI and avoids flashing a broken
 * link on first paint inside Docker.
 */

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

const VSCODE_NEW_WINDOW_QUERY = 'windowId=_blank';

/** Build a VS Code protocol URI that opens a path without replacing the active window. */
export function buildIdeUri(workingPath: string): string {
  // Normalise backslashes for Windows paths the same way the old UI does.
  const normalised = workingPath.replace(/\\/g, '/');
  return `vscode://file/${normalised}?${VSCODE_NEW_WINDOW_QUERY}`;
}

/** Open a host path in the user's editor via the vscode:// scheme. */
export function openInIde(workingPath: string): void {
  window.open(buildIdeUri(workingPath), '_blank');
}
