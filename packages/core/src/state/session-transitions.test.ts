import { describe, test, expect } from 'bun:test';
import {
  type TransitionTrigger,
  shouldCreateNewSession,
  shouldDeactivateSession,
  detectPlanToExecuteTransition,
  getTriggerForCommand,
} from './session-transitions';

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

    test('returns null for commands without triggers', () => {
      expect(getTriggerForCommand('help')).toBeNull();
      expect(getTriggerForCommand('status')).toBeNull();
      expect(getTriggerForCommand('commands')).toBeNull();
      expect(getTriggerForCommand('getcwd')).toBeNull();
    });
  });
});
