// @archon-test-isolated
import { providerRegistry } from '@archon/providers';
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import { handleCommand, startWorkflow } from '../command-handler';
import {
  operator,
  makeConversation,
  startRequest,
  spyDiscoverWorkflows,
  restoreSpies,
  stubWorkflowCodebase,
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
    describe('/workflow list', () => {
      const conversationWithCodebase = makeConversation({
        ...baseConversation,
        codebase_id: 'codebase-123',
      });

      beforeEach(() => {
        stubWorkflowCodebase();
      });

      test('should show load errors alongside workflows', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
          errors: [
            {
              filename: 'broken.yaml',
              error: 'YAML parse error: unexpected token',
              errorType: 'parse_error' as const,
            },
          ],
        });

        const result = await handleCommand(conversationWithCodebase, '/workflow list', operator);

        expect(result.success).toBe(true);
        expect(result.message).toContain('assist');
        expect(result.message).toContain('1 workflow(s) failed to load');
        expect(result.message).toContain('broken.yaml');
        expect(result.message).toContain('YAML parse error');
      });

      test('should show only errors when no workflows loaded', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [],
          errors: [
            {
              filename: 'bad.yaml',
              error: "Missing required field 'name'",
              errorType: 'validation_error' as const,
            },
          ],
        });

        const result = await handleCommand(conversationWithCodebase, '/workflow list', operator);

        expect(result.success).toBe(true);
        expect(result.message).toContain('1 workflow(s) failed to load');
        expect(result.message).toContain('bad.yaml');
      });

      test('should truncate errors at 10 and show count', async () => {
        const errors = Array.from({ length: 15 }, (_, i) => ({
          filename: `broken-${String(i)}.yaml`,
          error: `Error in file ${String(i)}`,
          errorType: 'parse_error' as const,
        }));

        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [],
          errors,
        });

        const result = await handleCommand(conversationWithCodebase, '/workflow list', operator);

        expect(result.success).toBe(true);
        expect(result.message).toContain('15 workflow(s) failed to load');
        expect(result.message).toContain('broken-0.yaml');
        expect(result.message).toContain('broken-9.yaml');
        expect(result.message).not.toContain('broken-10.yaml');
        expect(result.message).toContain('and 5 more');
      });

      test('passes config loading and the host registry to discovery', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [makeTestWorkflowWithSource({ name: 'test-wf', description: 'Test' })],
          errors: [],
        });

        await handleCommand(conversationWithCodebase, '/workflow list', operator);

        expect(spyDiscoverWorkflows).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(Function),
          providerRegistry
        );
      });

      // #2213 — chat is the surface most non-CLI authors use; a silently
      // dropped key (e.g. an `interactive:` they believe is a gate) has to
      // reach the conversation, not only `archon validate workflows`.
      test('should show parse warnings inline with the workflow that raised them', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'clean' }),
            makeTestWorkflowWithSource({ name: 'gated' }, 'project', [
              "Node 'plan': unknown key 'interactive' will be ignored.",
            ]),
          ],
          errors: [],
        });

        const result = await handleCommand(conversationWithCodebase, '/workflow list', operator);

        expect(result.success).toBe(true);
        expect(result.message).toContain("unknown key 'interactive' will be ignored");
        // Rendered under `gated`, not under `clean` — the author must be able to
        // tell which workflow is affected without cross-referencing.
        const gatedIdx = result.message.indexOf('`gated`');
        const warningIdx = result.message.indexOf("unknown key 'interactive'");
        expect(gatedIdx).toBeGreaterThan(-1);
        expect(warningIdx).toBeGreaterThan(gatedIdx);
      });
    });

    describe('/workflow reload', () => {
      const conversationWithCodebase = makeConversation({
        ...baseConversation,
        codebase_id: 'codebase-123',
      });

      beforeEach(() => {
        stubWorkflowCodebase();
      });

      test('should show error count on reload', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'assist', description: 'General assistant' }),
          ],
          errors: [
            {
              filename: 'broken.yaml',
              error: 'YAML parse error',
              errorType: 'parse_error' as const,
            },
            {
              filename: 'invalid.yml',
              error: "Missing 'nodes'",
              errorType: 'validation_error' as const,
            },
          ],
        });

        const result = await handleCommand(conversationWithCodebase, '/workflow reload', operator);

        expect(result.success).toBe(true);
        expect(result.message).toContain('Discovered 1 workflow(s)');
        expect(result.message).toContain('2 failed to load');
        expect(result.message).toContain('broken.yaml');
        expect(result.message).toContain('invalid.yml');
      });

      test('should show clean reload when no errors', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'assist', description: 'General assistant' }),
          ],
          errors: [],
        });

        const result = await handleCommand(conversationWithCodebase, '/workflow reload', operator);

        expect(result.success).toBe(true);
        expect(result.message).toContain('Discovered 1 workflow(s)');
        expect(result.message).not.toContain('failed to load');
      });
    });

    describe('/workflow run with load errors', () => {
      const conversationWithCodebase = makeConversation({
        ...baseConversation,
        codebase_id: 'codebase-123',
      });

      beforeEach(() => {
        stubWorkflowCodebase();
      });

      test('should show load error when workflow failed to parse', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [],
          errors: [
            {
              filename: 'fix-issue.yaml',
              error: 'YAML parse error near line 5',
              errorType: 'parse_error' as const,
            },
          ],
        });

        const result = await handleCommand(
          conversationWithCodebase,
          '/workflow run fix-issue',
          operator
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('failed to load');
        expect(result.message).toContain('YAML parse error near line 5');
      });

      test('should match workflow name case-insensitively', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'assist', description: 'General assistant' }),
          ],
          errors: [],
        });

        const result = await handleCommand(
          conversationWithCodebase,
          '/workflow run Assist',
          operator
        );

        expect(result.success).toBe(true);
        expect(startRequest(result.workflow).definition.name).toBe('assist');
      });

      // #2213 — the run path, not just `/workflow list`. Chat and the console
      // both start runs through here; discarding parseWarnings meant the author
      // saw a warning while browsing and silence at the moment of consequence.
      test('should carry parse warnings on the run result', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'clean' }),
            makeTestWorkflowWithSource({ name: 'gated' }, 'project', [
              "Node 'plan': unknown key 'interactive' will be ignored.",
            ]),
          ],
          errors: [],
        });

        const result = await handleCommand(
          conversationWithCodebase,
          '/workflow run gated',
          operator
        );

        expect(result.success).toBe(true);
        expect(startRequest(result.workflow).definition.name).toBe('gated');
        expect(startRequest(result.workflow).parseWarnings).toEqual([
          "Node 'plan': unknown key 'interactive' will be ignored.",
        ]);
      });

      test('should omit parse warnings for a clean workflow', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'clean' }),
            // A DIFFERENT workflow's warnings must not attach to this run.
            makeTestWorkflowWithSource({ name: 'gated' }, 'project', ["dropped 'interactive'"]),
          ],
          errors: [],
        });

        const result = await handleCommand(
          conversationWithCodebase,
          '/workflow run clean',
          operator
        );

        expect(result.success).toBe(true);
        expect(startRequest(result.workflow).parseWarnings).toBeUndefined();
      });

      test('should match workflow name via suffix match', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'acme-assist', description: 'General assistant' }),
          ],
          errors: [],
        });

        const result = await handleCommand(
          conversationWithCodebase,
          '/workflow run assist',
          operator
        );

        expect(result.success).toBe(true);
        expect(startRequest(result.workflow).definition.name).toBe('acme-assist');
      });

      test('should match workflow name via substring match', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({
              name: 'acme-smart-pr-review',
              description: 'Smart PR review',
            }),
          ],
          errors: [],
        });

        const result = await handleCommand(
          conversationWithCodebase,
          '/workflow run smart',
          operator
        );

        expect(result.success).toBe(true);
        expect(startRequest(result.workflow).definition.name).toBe('acme-smart-pr-review');
      });

      test('should return failure with candidates on ambiguous suffix match', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'archon-review', description: 'Review' }),
            makeTestWorkflowWithSource({ name: 'custom-review', description: 'Custom review' }),
          ],
          errors: [],
        });

        const result = await handleCommand(
          conversationWithCodebase,
          '/workflow run review',
          operator
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('Ambiguous workflow');
        expect(result.message).toContain('archon-review');
        expect(result.message).toContain('custom-review');
      });
    });

    describe('/workflow run', () => {
      const conversationWithCodebase = makeConversation({
        ...baseConversation,
        codebase_id: 'codebase-123',
      });

      beforeEach(() => {
        stubWorkflowCodebase();
      });

      test('should return error when no workflow name is provided', async () => {
        const result = await handleCommand(conversationWithCodebase, '/workflow run', operator);

        expect(result.success).toBe(false);
        expect(result.message).toContain('Usage: /workflow run <name>');
        expect(result.message).toContain('/workflow list');
      });

      test('should return error when workflow is not found', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({
              name: 'existing-workflow',
              description: 'An existing workflow',
            }),
          ],
          errors: [],
        });

        const result = await handleCommand(
          conversationWithCodebase,
          '/workflow run nonexistent',
          operator
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('Workflow `nonexistent` not found');
        expect(result.message).toContain('/workflow list');
      });

      test('should return success with workflow info when workflow is found', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'test-workflow', description: 'A test workflow' }),
          ],
          errors: [],
        });

        const result = await handleCommand(
          conversationWithCodebase,
          '/workflow run test-workflow',
          operator
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('Starting workflow: `test-workflow`');
        expect(result.workflow).toBeDefined();
        expect(startRequest(result.workflow).definition.name).toBe('test-workflow');
        expect(startRequest(result.workflow).args).toBe('');
      });

      test('should pass arguments to workflow', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'fix-issue', description: 'Fix a GitHub issue' }),
          ],
          errors: [],
        });

        const result = await handleCommand(
          conversationWithCodebase,
          '/workflow run fix-issue #42 add dark mode',
          operator
        );

        expect(result.success).toBe(true);
        expect(result.workflow).toBeDefined();
        expect(startRequest(result.workflow).definition.name).toBe('fix-issue');
        expect(startRequest(result.workflow).args).toBe('#42 add dark mode');
      });

      test('should parse --force after workflow name and strip it from args', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'test-workflow', description: 'A test workflow' }),
          ],
          errors: [],
        });

        const result = await handleCommand(
          conversationWithCodebase,
          '/workflow run test-workflow --force do it',
          operator
        );

        expect(result.success).toBe(true);
        expect(startRequest(result.workflow).force).toBe(true);
        expect(startRequest(result.workflow).args).toBe('do it');
      });

      test('should parse --force anywhere in workflow args and strip it', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'test-workflow', description: 'A test workflow' }),
          ],
          errors: [],
        });

        const result = await handleCommand(
          conversationWithCodebase,
          '/workflow run test-workflow do --force it',
          operator
        );

        expect(result.success).toBe(true);
        expect(startRequest(result.workflow).force).toBe(true);
        expect(startRequest(result.workflow).args).toBe('do it');
      });

      test('should leave force unset when --force is absent', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'test-workflow', description: 'A test workflow' }),
          ],
          errors: [],
        });

        const result = await handleCommand(
          conversationWithCodebase,
          '/workflow run test-workflow do it',
          operator
        );

        expect(result.success).toBe(true);
        expect(startRequest(result.workflow).force).toBeUndefined();
        expect(startRequest(result.workflow).args).toBe('do it');
      });

      // The run route's entry: the message is the run's $ARGUMENTS byte for byte, and
      // only the caller's `force` argument sets force (#4159).
      test.each([
        'Explain what git push --force does',
        'Fix the "login bug"\n\nsteps:\n  1. a',
        "'tis the season",
      ])('startWorkflow keeps the message verbatim: %j', async message => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'test-workflow', description: 'A test workflow' }),
          ],
          errors: [],
        });

        const result = await startWorkflow(
          conversationWithCodebase,
          'test-workflow',
          message,
          false,
          {}
        );

        expect(startRequest(result.workflow).args).toBe(message);
        expect(startRequest(result.workflow).force).toBeUndefined();
      });

      test('should return not-found when no codebase is configured', async () => {
        const result = await handleCommand(
          baseConversation,
          '/workflow run test-workflow',
          operator
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('Workflow `test-workflow` not found');
      });
    });

    describe('/workflow help text', () => {
      const conversationWithCodebase = makeConversation({
        ...baseConversation,
        codebase_id: 'codebase-123',
      });

      beforeEach(() => {
        stubWorkflowCodebase();
      });

      test('should show run command in workflow usage help', async () => {
        const result = await handleCommand(conversationWithCodebase, '/workflow invalid', operator);

        expect(result.success).toBe(false);
        expect(result.message).toContain('/workflow run');
      });

      test('should show status in workflow usage help', async () => {
        const result = await handleCommand(conversationWithCodebase, '/workflow invalid', operator);

        expect(result.success).toBe(false);
        expect(result.message).toContain('/workflow status');
        expect(result.message).toContain('/workflow resume <id> - Resume a failed or paused run');
      });
    });
  });
});
