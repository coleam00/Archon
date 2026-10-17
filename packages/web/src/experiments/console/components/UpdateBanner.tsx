import { useState, type ReactElement } from 'react';
import * as skill from '../skills';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';

const dismissalKey = (version: string): string => `console:updateDismissed:${version}`;

function dismissUpdate(version: string): void {
  try {
    localStorage.setItem(dismissalKey(version), 'true');
  } catch (error) {
    // Storage may be disabled; the component still dismisses for this session.
    console.debug('Update dismissal could not be saved', error);
  }
}

function isDismissed(version: string): boolean {
  try {
    return localStorage.getItem(dismissalKey(version)) === 'true';
  } catch {
    return false;
  }
}

export function UpdateBanner(): ReactElement | null {
  const { data: update } = useEntity(K.updateCheck, skill.getUpdateCheck);
  const [dismissedVersion, setDismissedVersion] = useState<string>();
  if (
    !update?.updateAvailable ||
    dismissedVersion === update.latestVersion ||
    isDismissed(update.latestVersion)
  )
    return null;

  return (
    <aside
      aria-label="Archon update"
      className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-surface-elevated px-4 py-3 text-sm"
    >
      <span>
        Archon {update.latestVersion} is available (installed: {update.currentVersion}).
      </span>
      <a
        className="text-accent underline"
        href="https://archon.diy/getting-started/updating/"
        target="_blank"
        rel="noreferrer"
      >
        How to update
      </a>
      <a
        className="text-accent underline"
        href={update.releaseUrl}
        target="_blank"
        rel="noreferrer"
      >
        Release notes
      </a>
      <button
        type="button"
        aria-label="Dismiss update notice"
        className="ml-auto rounded border border-border px-2 py-1"
        onClick={() => {
          dismissUpdate(update.latestVersion);
          setDismissedVersion(update.latestVersion);
        }}
      >
        Dismiss
      </button>
    </aside>
  );
}
