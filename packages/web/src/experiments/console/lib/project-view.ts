/**
 * Which view a project was last opened in, so picking a project lands where the
 * user left it rather than always on Runs.
 *
 * Backed by localStorage, like every other console UI preference (the rail
 * width, the run-detail toggles). That makes it per browser profile, which is
 * per user in practice. It deliberately does not follow a user between devices:
 * a view preference is not worth a server round trip on every project switch,
 * nor a row in the per-user prefs table.
 */

export type ProjectView = 'runs' | 'chat';

const KEY_PREFIX = 'archon.console.projectView.';

/** Per-project key — one project's choice never leaks into another's. */
export function projectViewKey(projectId: string): string {
  return `${KEY_PREFIX}${projectId}`;
}

/**
 * Normalise a stored value. Anything unrecognised — a stale key from an older
 * build, a hand-edited value — reads as "no preference" rather than throwing or
 * routing somewhere that does not exist.
 */
export function parseProjectView(raw: string | null): ProjectView | null {
  return raw === 'runs' || raw === 'chat' ? raw : null;
}

export function readProjectView(projectId: string): ProjectView | null {
  try {
    return parseProjectView(localStorage.getItem(projectViewKey(projectId)));
  } catch {
    // Storage access throws with cookies disabled and in some private-browsing
    // modes. "No preference" is a perfectly good answer there.
    return null;
  }
}

export function writeProjectView(projectId: string, view: ProjectView): void {
  try {
    localStorage.setItem(projectViewKey(projectId), view);
  } catch {
    // Best-effort: failing to remember the tab must never break navigating.
  }
}
