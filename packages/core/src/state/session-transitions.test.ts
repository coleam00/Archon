import { describe, test, expect, spyOn } from 'bun:test';
import {
  type TransitionTrigger,
  shouldCreateNewSession,
  shouldDeactivateSession,
  detectPlanToExecuteTransition,
  getTriggerForCommand,
  safeDeactivateSession,
} from './session-transitions';
// Spied (NOT mock.module'd — db/sessions.test.ts tests the real module in this
// same bun test batch, and mock.module pollution is process-global/irreversible).
import * as sessionDb from '../db/sessions';
import { SessionNotFoundError } from '../db/sessions';

describe('session-transitions', () => {
  describe('shouldCreateNewSession', () => {
    test('returns true for plan-to-execute', () => {
      expect(shouldCreateNewSession('plan-to-execute')).toBe(true);
    });

    test('returns false for first-message (session created differently)', () => {
      expect(shouldCreateNewSession('first-message')).toBe(false);
    });

    test('returns false for deactivate-only triggers', () => {
      const deactivateOnly: TransitionTrigger[] = [
        'isolation-changed',
        'project-changed',
        'reset-requested',
        'worktree-removed',
        'conversation-closed',
      ];
      for (const trigger of deactivateOnly) {
        expect(shouldCreateNewSession(trigger)).toBe(false);
      }
    });
  });

  describe('shouldDeactivateSession', () => {
    test('returns true for plan-to-execute', () => {
      expect(shouldDeactivateSession('plan-to-execute')).toBe(true);
    });

    test('returns true for all deactivate-only triggers', () => {
      const deactivateOnly: TransitionTrigger[] = [
        'isolation-changed',
        'project-changed',
        'reset-requested',
        'worktree-removed',
        'conversation-closed',
      ];
      for (const trigger of deactivateOnly) {
        expect(shouldDeactivateSession(trigger)).toBe(true);
      }
    });

    test('returns false for first-message (no session to deactivate)', () => {
      expect(shouldDeactivateSession('first-message')).toBe(false);
    });
  });

  describe('detectPlanToExecuteTransition', () => {
    test('detects execute after plan-feature', () => {
      expect(detectPlanToExecuteTransition('execute', 'plan-feature')).toBe('plan-to-execute');
    });

    test('detects execute-github after plan-feature-github', () => {
      expect(detectPlanToExecuteTransition('execute-github', 'plan-feature-github')).toBe(
        'plan-to-execute'
      );
    });

    test('returns null for execute with different lastCommand', () => {
      expect(detectPlanToExecuteTransition('execute', 'assist')).toBeNull();
      expect(detectPlanToExecuteTransition('execute', 'prime')).toBeNull();
      expect(detectPlanToExecuteTransition('execute', undefined)).toBeNull();
    });

    test('returns null when inputs are null', () => {
      expect(detectPlanToExecuteTransition(null, 'plan-feature')).toBeNull();
      expect(detectPlanToExecuteTransition('execute', null)).toBeNull();
      expect(detectPlanToExecuteTransition(null, null)).toBeNull();
    });

    test('returns null for non-execute commands', () => {
      expect(detectPlanToExecuteTransition('plan-feature', undefined)).toBeNull();
      expect(detectPlanToExecuteTransition('assist', 'plan-feature')).toBeNull();
      expect(detectPlanToExecuteTransition(undefined, 'plan-feature')).toBeNull();
    });

    test('returns null when execute-github follows wrong lastCommand', () => {
      expect(detectPlanToExecuteTransition('execute-github', 'plan-feature')).toBeNull();
      expect(detectPlanToExecuteTransition('execute', 'plan-feature-github')).toBeNull();
    });
  });

  describe('getTriggerForCommand', () => {
    test('maps reset to reset-requested', () => {
      expect(getTriggerForCommand('reset')).toBe('reset-requested');
    });

    test('maps worktree-remove to worktree-removed', () => {
      expect(getTriggerForCommand('worktree-remove')).toBe('worktree-removed');
    });

    test('maps setproject to project-changed', () => {
      expect(getTriggerForCommand('setproject')).toBe('project-changed');
    });

    test('returns null for commands without triggers', () => {
      expect(getTriggerForCommand('help')).toBeNull();
      expect(getTriggerForCommand('status')).toBeNull();
      expect(getTriggerForCommand('commands')).toBeNull();
      expect(getTriggerForCommand('getcwd')).toBeNull();
    });
  });

  describe('safeDeactivateSession', () => {
    test('resolves the trigger via the command map for every deactivating command', async () => {
      const spy = spyOn(sessionDb, 'deactivateSession').mockResolvedValue(undefined as never);
      try {
        await safeDeactivateSession('s-1', 'reset');
        await safeDeactivateSession('s-2', 'setproject');
        await safeDeactivateSession('s-3', 'worktree-remove');
        expect(spy.mock.calls).toEqual([
          ['s-1', 'reset-requested'],
          ['s-2', 'project-changed'],
          ['s-3', 'worktree-removed'],
        ]);
      } finally {
        spy.mockRestore();
      }
    });

    test('treats SessionNotFoundError as benign (row deleted mid-race)', async () => {
      const spy = spyOn(sessionDb, 'deactivateSession').mockRejectedValue(
        new SessionNotFoundError('s-gone')
      );
      try {
        await expect(safeDeactivateSession('s-gone', 'setproject')).resolves.toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });

    test('rethrows any other deactivation failure', async () => {
      const spy = spyOn(sessionDb, 'deactivateSession').mockRejectedValue(
        new Error('connection lost')
      );
      try {
        await expect(safeDeactivateSession('s-1', 'reset')).rejects.toThrow('connection lost');
      } finally {
        spy.mockRestore();
      }
    });
  });
});
