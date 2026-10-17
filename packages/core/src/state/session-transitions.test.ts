import { describe, test, expect, spyOn } from 'bun:test';
import { getTriggerForCommand, safeDeactivateSession } from './session-transitions';
import * as sessionDb from '../db/sessions';
import { SessionNotFoundError } from '../db/sessions';

describe('session-transitions', () => {
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
