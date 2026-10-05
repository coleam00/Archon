/**
 * Browser side of the run attention alerts (#1699): the per-browser on/off
 * setting, the sound, the system notification, and what the browser refused.
 * Which run changes deserve an alert is decided by lib/run-attention.ts.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import chimeUrl from '../assets/attention-chime.wav';
import * as skill from '../skills';
import type { Run } from '../primitives/run';
import { runStatusLabel } from './run-status';
import { watchRunAttention, type RunAttentionWatcher } from './run-attention';

const ENABLED_KEY = 'archon.console.attentionAlerts';

export type NotificationAccess = NotificationPermission | 'unsupported';

export interface AttentionAlertsState {
  enabled: boolean;
  notifications: NotificationAccess;
  /** Why the last alert sound did not play; cleared by the next one that does. */
  soundError: string | null;
  notificationError: string | null;
  /** Why the console could not read run state for alerts; cleared by the next read that works. */
  watchError: string | null;
}

function readEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

function readNotificationAccess(): NotificationAccess {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

let state: AttentionAlertsState = {
  enabled: readEnabled(),
  notifications: readNotificationAccess(),
  soundError: null,
  notificationError: null,
  watchError: null,
};
const listeners = new Set<() => void>();

function update(next: Partial<AttentionAlertsState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

export function getAttentionAlertsState(): AttentionAlertsState {
  return state;
}

export function useAttentionAlerts(): AttentionAlertsState {
  return useSyncExternalStore(subscribe, getAttentionAlertsState);
}

let chime: HTMLAudioElement | null = null;

function playChime(): void {
  chime ??= new Audio(chimeUrl);
  chime.currentTime = 0;
  chime.play().then(
    () => {
      update({ soundError: null });
    },
    (e: unknown) => {
      update({
        soundError:
          e instanceof DOMException && e.name === 'NotAllowedError'
            ? 'The browser blocked the alert sound because this tab has not been clicked since it loaded. Click anywhere in the console to allow it.'
            : `The alert sound could not play: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  );
}

/**
 * Must run inside a click handler: the click is the user gesture browsers require
 * before they allow sound or ask for notification permission. The preview chime
 * confirms the sound works.
 */
export function enableAttentionAlerts(): void {
  try {
    localStorage.setItem(ENABLED_KEY, '1');
  } catch {
    /* the setting still applies until the page reloads */
  }
  update({ enabled: true, watchError: null });
  playChime();
  requestNotificationAccess();
}

export function disableAttentionAlerts(): void {
  try {
    localStorage.setItem(ENABLED_KEY, '0');
  } catch {
    /* ignore */
  }
  update({ enabled: false, watchError: null });
}

/** Permission can change in the browser's site settings while the console is open. */
export function refreshNotificationAccess(): void {
  const notifications = readNotificationAccess();
  if (notifications !== state.notifications) update({ notifications });
}

/** Must run inside a click handler, like {@link enableAttentionAlerts}. */
export function requestNotificationAccess(): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'default') return;
  Notification.requestPermission().then(
    permission => {
      update({ notifications: permission });
    },
    (e: unknown) => {
      update({
        notificationError: `The browser could not ask for notification permission: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  );
}

function alertRun(run: Run): void {
  playChime();
  if (readNotificationAccess() !== 'granted') return;
  try {
    // Workflow name and state only: run output and messages stay in the console.
    const notification = new Notification(run.workflow, {
      body: runStatusLabel(run),
      tag: run.id,
    });
    notification.onclick = (): void => {
      window.focus();
    };
    update({ notificationError: null });
  } catch (e) {
    // Chrome on Android exposes Notification but only allows it from a service worker.
    update({
      notificationError: `The browser refused to show a notification: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

/**
 * Watches runs for attention alerts while the setting is on. Returns the handler
 * the dashboard stream calls for every run change; mount once, at the console root.
 */
export function useRunAttentionAlerts(): (runId: string) => void {
  const { enabled } = useAttentionAlerts();
  const watcher = useRef<RunAttentionWatcher | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const w = watchRunAttention(
      {
        // The server caps the page size; the watcher pages on until `total`.
        listRuns: offset => skill.listRuns({ offset, limit: 1000 }),
        getRun: async runId => (await skill.getRun(runId)).run,
      },
      {
        onAttention: alertRun,
        onError: e => {
          console.warn('[console-attention] could not read run state', e);
          update({ watchError: e.message });
        },
        onRecovered: () => {
          update({ watchError: null });
        },
      }
    );
    watcher.current = w;
    return (): void => {
      w.stop();
      watcher.current = null;
    };
  }, [enabled]);

  return useCallback((runId: string) => {
    watcher.current?.runChanged(runId);
  }, []);
}
