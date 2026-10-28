// @archon-test-isolated
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { parseCommand, handleCommand } from './command-handler';
import { quoteCommandArg } from '../utils/command-args';
import {
  operator,
  EMPTY_DASHBOARD_COUNTS,
  makeConversation,
  makeWorkflowRun,
  makeDashboardRun,
  mockGetActiveWorkflowRun,
  mockListDashboardRuns,
  mockGetWorkflowRun,
  mockFindWorkflowRunsByIdPrefix,
  spyDiscoverWorkflows,
  restoreSpies,
  stubWorkflowCodebase,
  baseConversation,
  approveConversation,
  resetCommandHandlerMocks,
} from './commands/test-harness';

describe('CommandHandler', () => {
  beforeEach(resetCommandHandlerMocks);

  // Clean up spies after all tests in this file to prevent contamination
  afterAll(() => {
    restoreSpies();
  });

  describe('parseCommand', () => {
    test('parses the exact multiword detach name as one argument', () => {
      expect(parseCommand('/detach-project "My App"')).toEqual({
        command: 'detach-project',
        args: ['My App'],
      });
    });

    test('should extract command and args from /clone command', () => {
      const result = parseCommand('/clone https://github.com/user/repo');
      expect(result.command).toBe('clone');
      expect(result.args).toEqual(['https://github.com/user/repo']);
    });

    test('should handle commands without args', () => {
      const result = parseCommand('/help');
      expect(result.command).toBe('help');
      expect(result.args).toEqual([]);
    });

    test('should handle /status command', () => {
      const result = parseCommand('/status');
      expect(result.command).toBe('status');
      expect(result.args).toEqual([]);
    });

    test('should handle /setcwd with path containing spaces', () => {
      const result = parseCommand('/setcwd /workspace/my repo');
      expect(result.command).toBe('setcwd');
      expect(result.args).toEqual(['/workspace/my', 'repo']);
    });

    test('parses a quoteCommandArg value back to the same string', () => {
      const name = 'Bob"s \\Ops';
      const result = parseCommand(`/update-project ${quoteCommandArg(name)} /new/path`);
      expect(result.args).toEqual([name, '/new/path']);
    });

    test('should handle /reset command', () => {
      const result = parseCommand('/reset');
      expect(result.command).toBe('reset');
      expect(result.args).toEqual([]);
    });

    test('should handle command with multiple spaces', () => {
      const result = parseCommand('/clone   https://github.com/user/repo  ');
      expect(result.command).toBe('clone');
      expect(result.args).toEqual(['https://github.com/user/repo']);
    });

    test('should handle /getcwd command', () => {
      const result = parseCommand('/getcwd');
      expect(result.command).toBe('getcwd');
      expect(result.args).toEqual([]);
    });

    test('should parse quoted arguments', () => {
      const result = parseCommand('/command-invoke plan "Add dark mode"');
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', 'Add dark mode']);
    });

    test('should parse mixed quoted and unquoted args', () => {
      const result = parseCommand('/command-set test .test.md "Task: $1"');
      expect(result.command).toBe('command-set');
      expect(result.args).toEqual(['test', '.test.md', 'Task: $1']);
    });

    test('should parse /command-set', () => {
      const result = parseCommand('/command-set prime .claude/prime.md');
      expect(result.command).toBe('command-set');
      expect(result.args).toEqual(['prime', '.claude/prime.md']);
    });

    test('should parse /load-commands', () => {
      const result = parseCommand('/load-commands .claude/commands');
      expect(result.command).toBe('load-commands');
      expect(result.args).toEqual(['.claude/commands']);
    });

    test('should handle single quotes', () => {
      const result = parseCommand("/command-invoke plan 'Add dark mode'");
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', 'Add dark mode']);
    });

    test('should parse /repos', () => {
      const result = parseCommand('/repos');
      expect(result.command).toBe('repos');
      expect(result.args).toEqual([]);
    });

    test('should parse /repo with number', () => {
      const result = parseCommand('/repo 1');
      expect(result.command).toBe('repo');
      expect(result.args).toEqual(['1']);
    });

    test('should parse /repo with name', () => {
      const result = parseCommand('/repo dylan');
      expect(result.command).toBe('repo');
      expect(result.args).toEqual(['dylan']);
    });

    test('should parse /repo with pull', () => {
      const result = parseCommand('/repo 1 pull');
      expect(result.command).toBe('repo');
      expect(result.args).toEqual(['1', 'pull']);
    });

    test('should parse /repo-remove with number', () => {
      const result = parseCommand('/repo-remove 1');
      expect(result.command).toBe('repo-remove');
      expect(result.args).toEqual(['1']);
    });

    test('should parse /repo-remove with name', () => {
      const result = parseCommand('/repo-remove my-repo');
      expect(result.command).toBe('repo-remove');
      expect(result.args).toEqual(['my-repo']);
    });

    test('should preserve multi-word quoted string as single argument', () => {
      const result = parseCommand('/command-invoke plan "here is the request"');
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', 'here is the request']);
      expect(result.args[1]).toBe('here is the request');
    });

    test('should handle long quoted sentences', () => {
      const result = parseCommand(
        '/command-invoke execute "Implement the user authentication feature with JWT tokens"'
      );
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual([
        'execute',
        'Implement the user authentication feature with JWT tokens',
      ]);
    });

    test('should handle multiple quoted arguments', () => {
      const result = parseCommand('/command-invoke test "first arg" "second arg" "third arg"');
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['test', 'first arg', 'second arg', 'third arg']);
    });

    test('should handle mixed quoted and unquoted with spaces', () => {
      const result = parseCommand('/command-invoke plan "Add feature X" --flag value');
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', 'Add feature X', '--flag', 'value']);
    });

    test('should handle quoted arg with special characters', () => {
      const result = parseCommand('/command-invoke plan "Fix bug #123: handle edge case"');
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', 'Fix bug #123: handle edge case']);
    });

    test('should handle empty quoted string', () => {
      const result = parseCommand('/command-invoke plan ""');
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', '']);
    });

    test('should unescape quoted workflow suggestions', () => {
      const result = parseCommand(
        '/workflow run test --force "fix \\\\ path \\"quoted\\" \\`tick\\`"'
      );
      expect(result.command).toBe('workflow');
      expect(result.args).toEqual(['run', 'test', '--force', 'fix \\ path "quoted" `tick`']);
    });

    test('should unescape single quoted strings', () => {
      const result = parseCommand("/command-invoke plan 'it\\'s \\\\ ready'");
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', "it's \\ ready"]);
    });

    test('should return empty command for non-slash-prefixed input (Windows Git Bash path expansion)', () => {
      const result = parseCommand('C:/Program Files/Git/status');
      expect(result.command).toBe('');
      expect(result.args).toEqual([]);
    });

    test('should return empty command for plain word without slash', () => {
      const result = parseCommand('status');
      expect(result.command).toBe('');
      expect(result.args).toEqual([]);
    });
  });

  describe('handleCommand', () => {
    describe('unknown command', () => {
      test('should return error for unknown command', async () => {
        const result = await handleCommand(baseConversation, '/unknown', operator);
        expect(result.success).toBe(false);
        expect(result.message).toContain('Unknown command');
        expect(result.message).toContain('/help');
      });
    });

    describe('command suggestions use the surface spelling', () => {
      // Mirrors the Slack adapter: its registered slash command is `/archon-workflow`.
      const slack = { formatWorkflowCommand: (command: string) => `/archon-workflow ${command}` };
      const projectConversation = makeConversation({
        ...baseConversation,
        codebase_id: 'codebase-123',
      });

      /** Every suggestion is spelled for Slack; none is the bare chat grammar. */
      function expectSlackSpelling(message: string): void {
        expect(message).toContain('/archon-workflow ');
        expect(message.replaceAll('/archon-workflow ', '')).not.toContain('/workflow ');
      }

      beforeEach(() => {
        stubWorkflowCodebase();
      });

      for (const command of [
        '/help',
        '/workflow invalid',
        '/workflow run',
        '/workflow resume',
        '/workflow abandon',
        '/workflow approve',
        '/workflow reject',
        '/workflow respond',
        '/workflow reset-sessions',
      ]) {
        test(`${command} reply`, async () => {
          const result = await handleCommand(projectConversation, command, operator, slack);
          expectSlackSpelling(result.message);
        });
      }

      test('/workflow run with an unknown workflow', async () => {
        spyDiscoverWorkflows?.mockResolvedValue({ workflows: [], errors: [] });
        const result = await handleCommand(
          projectConversation,
          '/workflow run nope',
          operator,
          slack
        );
        expectSlackSpelling(result.message);
      });

      test('/status with an active workflow', async () => {
        mockGetActiveWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({ id: 'wf-active', workflow_name: 'investigate', user_message: 'x' })
        );
        const result = await handleCommand(baseConversation, '/status', operator, slack);
        expectSlackSpelling(result.message);
      });

      test('/workflow status with runs needing action', async () => {
        mockListDashboardRuns.mockResolvedValueOnce({
          runs: [
            makeDashboardRun({ id: 'run-live', status: 'running' }),
            makeDashboardRun({
              id: 'run-attention',
              status: 'paused',
              metadata: {
                wait: {
                  owner: 'node',
                  nodeId: 'rerun-ci',
                  kind: 'attention',
                  waitingSince: '2026-08-31T10:00:00.000Z',
                  message: 'Re-run the check.',
                },
              },
            }),
            makeDashboardRun({
              id: 'run-approval',
              status: 'paused',
              metadata: { approval: { nodeId: 'gate', message: 'Approve?' } },
            }),
          ],
          total: 3,
          counts: { ...EMPTY_DASHBOARD_COUNTS, all: 3, running: 1, paused: 2 },
        });
        const result = await handleCommand(baseConversation, '/workflow status', operator, slack);
        expectSlackSpelling(result.message);
        expect(result.message).toContain('/archon-workflow resume run-attention');
        expect(result.message).toContain('/archon-workflow approve run-approval');
        expect(result.message).toContain('/archon-workflow cancel <id>');
      });

      test('/workflow cancel refused with no owner answering', async () => {
        const orphan = makeWorkflowRun({
          id: 'wf-orphan',
          status: 'running' as const,
          user_message: 'x',
          last_activity_at: new Date(),
        });
        mockGetActiveWorkflowRun.mockResolvedValueOnce(orphan);
        mockGetWorkflowRun.mockResolvedValueOnce(orphan);
        const result = await handleCommand(
          projectConversation,
          '/workflow cancel',
          operator,
          slack
        );
        expect(result.success).toBe(false);
        expect(result.message).toContain('Abandon it: `/archon-workflow abandon wf-orphan`');
        expectSlackSpelling(result.message);
      });

      test('an approval whose continuation cannot be resolved', async () => {
        const run = makeWorkflowRun({
          id: 'run-gate',
          workflow_name: 'gated-wf',
          status: 'paused' as const,
          user_message: 'x',
          metadata: { approval: { type: 'approval', nodeId: 'review', message: 'Approve?' } },
          last_activity_at: new Date(),
        });
        mockGetWorkflowRun.mockResolvedValueOnce(run).mockResolvedValueOnce(null);
        const result = await handleCommand(
          approveConversation,
          '/workflow approve run-gate',
          operator,
          slack
        );
        expect(result.message).toContain('could not be continued');
        expect(result.message).toContain('/archon-workflow resume run-gate');
        expectSlackSpelling(result.message);
      });

      // The child-run redirect is built by core, which has no surface. #3488: it used
      // to reach Slack as the raw chat grammar the operations wrote.
      // Each verb reports through its own catch block, so each is asserted.
      for (const { args, redirect } of [
        { args: 'approve parent-stuck', redirect: 'approve child-77' },
        { args: 'reject parent-stuck', redirect: 'reject child-77' },
        { args: 'respond parent-stuck approve', redirect: 'approve child-77' },
      ]) {
        test(`/workflow ${args} on a parent blocked on a sub-run`, async () => {
          const parent = makeWorkflowRun({
            id: 'parent-stuck',
            codebase_id: projectConversation.codebase_id,
            status: 'paused' as const,
            user_message: 'x',
            metadata: {
              approval: {
                nodeId: 'sub',
                message: 'waiting on sub-run',
                type: 'child_workflow',
                childRunId: 'child-77',
              },
            },
          });
          mockFindWorkflowRunsByIdPrefix.mockResolvedValueOnce([parent]);
          mockGetWorkflowRun.mockResolvedValueOnce(parent);
          const result = await handleCommand(
            projectConversation,
            `/workflow ${args}`,
            operator,
            slack
          );
          expect(result.success).toBe(false);
          expect(mockFindWorkflowRunsByIdPrefix).toHaveBeenCalledWith(
            parent.id,
            projectConversation.codebase_id
          );
          expect(result.message).toContain(`/archon-workflow ${redirect}`);
          expectSlackSpelling(result.message);
        });
      }

      test('a surface without its own spelling keeps /workflow', async () => {
        const result = await handleCommand(projectConversation, '/workflow invalid', operator, {});
        expect(result.message).toContain('/workflow status');
        expect(result.message).not.toContain('/archon-workflow');
      });
    });
  });
});
