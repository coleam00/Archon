import {
  useBrowserPush,
  refreshBrowserPush,
  enableBrowserPush,
  disableBrowserPush,
} from '../lib/web-push';
import { useEffect, type ReactElement } from 'react';
import {
  disableAttentionAlerts,
  enableAttentionAlerts,
  refreshNotificationAccess,
  requestNotificationAccess,
  useAttentionAlerts,
  type NotificationAccess,
} from '../lib/attention-alerts';
import { SettingsSection } from './SettingsSection';

/** Per-browser toggle for run attention alerts, and what the browser blocked (#1699). */
export function AttentionAlertsPanel(): ReactElement {
  const alerts = useAttentionAlerts();
  const push = useBrowserPush();

  useEffect(() => {
    refreshNotificationAccess();
    void refreshBrowserPush();
  }, []);

  const problems = [
    alerts.saveError,
    alerts.soundError,
    alerts.notificationError,
    alerts.watchError,
    push.error,
  ].filter((p): p is string => p !== null);

  return (
    <SettingsSection title="Alerts">
      <div className="flex flex-col gap-3 text-[12px]">
        <label className="flex cursor-pointer select-none items-start gap-2 text-text-secondary">
          <input
            type="checkbox"
            checked={alerts.enabled}
            onChange={e => {
              if (e.target.checked) enableAttentionAlerts();
              else disableAttentionAlerts();
            }}
            className="mt-0.5 h-3.5 w-3.5 cursor-pointer accent-[color:var(--accent-bright)]"
          />
          <span>
            <span className="text-text-primary">
              Play a sound and show a notification when a run waits for you or finishes
            </span>
            <br />
            Saved in this browser only.
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-2 text-text-secondary">
          <input
            type="checkbox"
            checked={push.enabled}
            disabled={push.busy || push.unsupported !== null}
            className="mt-0.5 h-3.5 w-3.5 cursor-pointer accent-[color:var(--accent-bright)]"
            onChange={e => {
              if (e.target.checked) void enableBrowserPush();
              else void disableBrowserPush();
            }}
          />
          <span>
            Also notify this browser when the console is closed
            <br />
            Requires a signed-in user. Every opted-in browser on this install receives notices.
          </span>
        </label>
        {push.unsupported ? (
          <p role="alert" className="text-error">
            {push.unsupported}
          </p>
        ) : null}

        {alerts.enabled ? <NotificationStatus access={alerts.notifications} /> : null}

        {problems.map(problem => (
          <p key={problem} role="alert" className="text-error">
            {problem}
          </p>
        ))}
      </div>
    </SettingsSection>
  );
}

function NotificationStatus({ access }: { access: NotificationAccess }): ReactElement {
  switch (access) {
    case 'granted':
      return <p className="text-text-secondary">Notifications are allowed.</p>;
    case 'default':
      return (
        <div className="flex items-center justify-between gap-3">
          <span className="text-text-secondary">
            Notifications are not allowed yet. Alerts only play a sound.
          </span>
          <button
            type="button"
            onClick={requestNotificationAccess}
            className="shrink-0 rounded border border-border px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary"
          >
            Allow notifications
          </button>
        </div>
      );
    case 'denied':
      return (
        <p role="alert" className="text-error">
          Notifications are blocked for this site. Alerts only play a sound until you allow
          notifications in the browser&apos;s site settings.
        </p>
      );
    case 'unsupported':
      return (
        <p role="alert" className="text-error">
          This browser cannot show notifications on this page; they need HTTPS or localhost. Alerts
          only play a sound.
        </p>
      );
  }
}
