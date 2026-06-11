import { type ReactElement } from 'react';
import type { SettingsScope } from '../skills';

/**
 * "This install / Just me" segmented toggle for the AI-settings panels
 * (Phase 3 per-user prefs). Render it only when the per-user scope is
 * available (GET /api/auth/me/ai-prefs didn't error) — the parent owns that
 * check so a solo/logged-out install never sees a dead control.
 */
export function ScopeToggle({
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
