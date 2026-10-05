import { type ReactElement } from 'react';
import type { SettingsScope } from '../skills';
import { HttpError, errorDetail } from '../lib/http';

/**
 * What the GET /api/auth/me/ai-prefs result allows the AI-settings panels to
 * offer. A 401 means no web identity (solo-PAT or logged out): there is nothing
 * personal to edit, so the "Just me" scope disappears without a word. Any other
 * failure is reported, never hidden — a silently missing control reads as
 * "feature missing" when the server is actually erroring.
 */
export type UserScopeStatus =
  | { kind: 'available' }
  | { kind: 'no-identity' }
  | { kind: 'load-failed'; error: Error };

export function userScopeStatus(prefsError: Error | undefined): UserScopeStatus {
  if (prefsError === undefined) return { kind: 'available' };
  if (prefsError instanceof HttpError && prefsError.status === 401) return { kind: 'no-identity' };
  return { kind: 'load-failed', error: prefsError };
}

export function UserPrefsLoadFailed({ error }: { error: Error }): ReactElement {
  return (
    <p role="alert" className="font-mono text-[11px] text-error">
      Couldn’t load your personal settings: {errorDetail(error)}
    </p>
  );
}

/**
 * The scope slot of a panel header: the toggle when the per-user scope is
 * available, the load failure when it is not, nothing on a 401.
 */
export function UserScopeSlot({
  status,
  scope,
  onChange,
}: {
  status: UserScopeStatus;
  scope: SettingsScope;
  onChange: (scope: SettingsScope) => void;
}): ReactElement | null {
  switch (status.kind) {
    case 'available':
      return <ScopeToggle scope={scope} onChange={onChange} />;
    case 'no-identity':
      return null;
    case 'load-failed':
      return <UserPrefsLoadFailed error={status.error} />;
  }
}

/** "This install / Just me" segmented toggle for the AI-settings panels. */
function ScopeToggle({
  scope,
  onChange,
}: {
  scope: SettingsScope;
  onChange: (scope: SettingsScope) => void;
}): ReactElement {
  const base =
    'rounded-[7px] px-2.5 py-[5px] font-mono text-[11px] font-semibold transition-colors';
  const active = 'bg-surface-elevated text-text-primary shadow-sm';
  const inactive = 'text-text-tertiary hover:text-text-secondary';
  return (
    <div
      role="group"
      aria-label="Settings scope"
      className="flex shrink-0 items-center gap-0.5 rounded-[9px] border border-border bg-surface-inset p-0.5"
    >
      <button
        type="button"
        aria-pressed={scope === 'install'}
        onClick={() => {
          onChange('install');
        }}
        className={`${base} ${scope === 'install' ? active : inactive}`}
      >
        This install
      </button>
      <button
        type="button"
        aria-pressed={scope === 'user'}
        onClick={() => {
          onChange('user');
        }}
        className={`${base} ${scope === 'user' ? active : inactive}`}
      >
        Just me
      </button>
    </div>
  );
}
