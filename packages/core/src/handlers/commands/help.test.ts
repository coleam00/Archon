// @archon-test-isolated
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { handleCommand } from '../command-handler';
import {
  operator,
  mockGetCodebaseCommands,
  restoreSpies,
  baseConversation,
  resetCommandHandlerMocks,
} from './test-harness';

describe('CommandHandler', () => {
  beforeEach(resetCommandHandlerMocks);

  // Clean up spies after all tests in this file to prevent contamination
  afterAll(() => {
    restoreSpies();
  });

  describe('handleCommand', () => {
    describe('/help', () => {
      test('should return help message', async () => {
        const result = await handleCommand(baseConversation, '/help', operator);
        expect(result.success).toBe(true);
        expect(result.message).toContain('Archon Orchestrator');
        expect(result.message).toContain('/workflow list');
        expect(result.message).toContain('/workflow resume <id>` — Resume a failed or paused run');
        expect(result.message).toContain('/status');
      });
    });

    describe('/commands', () => {
      test('should return error without codebase', async () => {
        const result = await handleCommand(baseConversation, '/commands', operator);
        expect(result.success).toBe(false);
        expect(result.message).toContain('No codebase');
      });

      test('should list registered commands', async () => {
        const conversation = { ...baseConversation, codebase_id: 'cb-123' };
        mockGetCodebaseCommands.mockResolvedValue({
          plan: { path: '.claude/commands/plan.md', description: 'Plan command' },
          execute: { path: '.claude/commands/execute.md', description: 'Execute command' },
        });

        const result = await handleCommand(conversation, '/commands', operator);
        expect(result.success).toBe(true);
        expect(result.message).toContain('plan');
        expect(result.message).toContain('execute');
      });

      test('should show message when no commands registered', async () => {
        const conversation = { ...baseConversation, codebase_id: 'cb-123' };
        mockGetCodebaseCommands.mockResolvedValue({});

        const result = await handleCommand(conversation, '/commands', operator);
        expect(result.success).toBe(true);
        expect(result.message).toContain('No commands registered');
      });

      test('should handle commands as JSON string from SQLite', async () => {
        const conversation = { ...baseConversation, codebase_id: 'cb-123' };
        mockGetCodebaseCommands.mockResolvedValue({
          plan: { path: '.claude/commands/plan.md', description: 'Plan command' },
        });

        const result = await handleCommand(conversation, '/commands', operator);
        expect(result.success).toBe(true);
        expect(result.message).toContain('plan');
        expect(result.message).not.toContain('undefined');
      });
    });
  });
});
