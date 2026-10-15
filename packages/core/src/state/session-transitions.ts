// NOTE: this module is no longer side-effect-free — safeDeactivateSession below
// imports the real ../db/sessions (lazy connection; nothing runs at import time).
// Any test that CALLS safeDeactivateSession must mock '../db/sessions' itself,
// or it will silently reach the real database via the lazy singleton.
import * as sessionDb from '../db/sessions';
import { SessionNotFoundError } from '../db/sessions';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('session-transitions');
  return cachedLog;
}

import type { TransitionTrigger } from '../schemas/session';
export type { TransitionTrigger } from '../schemas/session';

/**
 * Commands that have known trigger mappings.
 * Used for function overloads to return non-null for known commands.
 */
export type DeactivatingCommand = 'reset' | 'setproject' | 'worktree-remove';

const COMMAND_TRIGGER_MAP: Record<DeactivatingCommand, TransitionTrigger> = {
  reset: 'reset-requested',
  setproject: 'project-changed',
  'worktree-remove': 'worktree-removed',
};

/**
 * Map command names to their transition triggers.
 * Used by command handler to determine which trigger to use.
 *
 * Known commands (DeactivatingCommand) return TransitionTrigger (non-null).
 * Unknown commands return TransitionTrigger | null.
 */
export function getTriggerForCommand(commandName: DeactivatingCommand): TransitionTrigger;
export function getTriggerForCommand(commandName: string): TransitionTrigger | null;
export function getTriggerForCommand(commandName: string): TransitionTrigger | null {
  return (COMMAND_TRIGGER_MAP as Record<string, TransitionTrigger>)[commandName] ?? null;
}

/**
 * Safely deactivate a session for a deactivating command. deactivateSession
 * throws SessionNotFoundError only when the session ROW no longer exists (its
 * UPDATE matches by id with no active filter, so an already-deactivated row
 * still matches). A row deleted between getActiveSession() and this call is
 * defensively treated as benign — with default 30-day retention that window is
 * practically unreachable, but the catch keeps the command from failing on it.
 *
 * Single shared implementation for every deactivating command (/reset,
 * /setproject, /worktree remove) — the trigger is resolved through
 * COMMAND_TRIGGER_MAP, never hardcoded at call sites.
 */
export async function safeDeactivateSession(
  sessionId: string,
  commandName: DeactivatingCommand
): Promise<void> {
  const trigger = getTriggerForCommand(commandName);
  try {
    await sessionDb.deactivateSession(sessionId, trigger);
    getLog().debug({ sessionId, trigger }, 'session_deactivated');
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      getLog().debug({ sessionId, trigger }, 'session_deactivate_row_missing');
    } else {
      throw error;
    }
  }
}
