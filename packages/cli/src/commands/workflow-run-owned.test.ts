import { mockLogger, createTestWorkflowHost } from '../test-support/workflow-command-harness';

import { providerRegistry } from '@archon/providers';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';

import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import { workflowRunCommand } from './workflow-run-owned';

describe('workflowRunCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.info.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should throw error when no workflows found', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [],
      errors: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello')
    ).rejects.toThrow('No workflows found in .archon/workflows/');
  });

  it('logs effective discovery root and source breakdown for every run', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist' }, 'bundled'),
        makeTestWorkflowWithSource({ name: 'home-helper' }, 'global'),
        makeTestWorkflowWithSource({ name: 'project-flow' }, 'project'),
      ],
      errors: [],
    });

    await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'hello', {
      noWorktree: true,
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      'Discovery: root=/repo/root workflows=3 bundled=1 global=1 project=1 installed=0'
    );
  });

  it('uses discoveryCwd in the discovery diagnostic when supplied', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' }, 'project')],
      errors: [],
    });

    await workflowRunCommand(createTestWorkflowHost(), '/tmp/worktree', 'assist', 'hello', {
      noWorktree: true,
      discoveryCwd: '/repo/source',
    });

    // The source is captured from the discovery root; discovery then reads that capture,
    // so the call carries the target cwd plus the capture's roots.
    const sourceDiag = await import('@archon/workflows/run-source');
    expect(sourceDiag.prepareWorkflowSource as ReturnType<typeof mock>).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceRoot: '/repo/source' })
    );
    expect(discoverWorkflowsWithConfig).toHaveBeenCalledWith(
      '/test/path',
      expect.any(Function),
      providerRegistry,
      expect.objectContaining({ project: join('/test/capture', 'project') })
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      'Discovery: root=/repo/source workflows=1 bundled=0 global=0 project=1 installed=0'
    );
  });

  it('does not print discovery diagnostic in json mode', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' }, 'project')],
      errors: [],
    });

    try {
      await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'hello', {
        json: true,
        noWorktree: true,
      });
    } catch {
      // Downstream failure is acceptable; this test only verifies diagnostic suppression.
    }

    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Discovery: root='));
  });

  // #2213 — `--json` silences Pino entirely (cli.ts sets the level to 'silent'),
  // so stderr is the only channel left. Note this asserts only the CHANNEL
  // (console.warn, not console.log); the JSON payload itself goes through
  // `writeJsonLine` on the `--detach` branch, covered in the detach describe.
  it('warns on stderr about keys the engine drops, even in json mode', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
      (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        workflows: [
          makeTestWorkflowWithSource({ name: 'assist' }, 'project', [
            "Node 'plan': unknown key 'interactive' will be ignored.",
          ]),
        ],
        errors: [],
      });

      try {
        await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'hello', {
          json: true,
          noWorktree: true,
        });
      } catch {
        // Downstream failure is acceptable; this test only checks the warning.
      }

      expect(warnSpy).toHaveBeenCalledWith("Warning: 'assist' declares keys the engine ignores:");
      expect(warnSpy).toHaveBeenCalledWith(
        "  - Node 'plan': unknown key 'interactive' will be ignored."
      );
      // Never on stdout — a --json caller must still get a parseable payload.
      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('unknown key'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('stays silent when the resolved workflow has no parse warnings', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
      (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        workflows: [
          makeTestWorkflowWithSource({ name: 'assist' }, 'project'),
          // A DIFFERENT workflow's warnings must not leak into this run.
          makeTestWorkflowWithSource({ name: 'other' }, 'project', ["dropped 'interactive'"]),
        ],
        errors: [],
      });

      await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'hello', {
        noWorktree: true,
      });

      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('the engine ignores'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  // #2781 — the deprecation notice rides the same stderr channel as the parse
  // warnings above, with the same --json-purity rationale.
  it('warns on stderr about a deprecated workflow', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
      (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        workflows: [
          makeTestWorkflowWithSource({
            name: 'assist',
            deprecated: { message: 'Switch to the sdlc pack instead.' },
          }),
        ],
        errors: [],
      });

      try {
        await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'hello', {
          noWorktree: true,
        });
      } catch {
        // Downstream failure is acceptable; this test only checks the notice.
      }

      expect(warnSpy).toHaveBeenCalledWith(
        '⚠️ `assist` is deprecated and will be removed in an upcoming release. ' +
          'Switch to the sdlc pack instead. ' +
          'To keep using this workflow after removal, copy the workflow file into your project ' +
          '`.archon/workflows/` or your global `~/.archon/workflows/`.'
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('stays silent when the resolved workflow is not deprecated', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
      (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist' }, 'project')],
        errors: [],
      });

      try {
        await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'hello', {
          noWorktree: true,
        });
      } catch {
        // Downstream failure is acceptable; this test only checks silence.
      }

      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('will be removed in an upcoming release')
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not print discovery diagnostic in quiet mode', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' }, 'project')],
      errors: [],
    });

    try {
      await workflowRunCommand(createTestWorkflowHost(), '/repo/root', 'assist', 'hello', {
        quiet: true,
        noWorktree: true,
      });
    } catch {
      // Downstream failure is acceptable; this test only verifies diagnostic suppression.
    }

    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Discovery: root='));
  });

  it('should throw error when workflow not found', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist', description: 'Help' }),
        makeTestWorkflowWithSource({ name: 'plan', description: 'Plan' }),
      ],
      errors: [],
    });

    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'nonexistent', 'hello')
    ).rejects.toThrow("Workflow 'nonexistent' not found");
  });

  it('should include suggested workflows in error when workflow not found', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist', description: 'Help' }),
        makeTestWorkflowWithSource({ name: 'plan', description: 'Plan' }),
      ],
      errors: [],
    });

    const run = workflowRunCommand(createTestWorkflowHost(), '/test/path', 'nonexistent', 'hello');
    await expect(run).rejects.toThrow('Did you mean:');
    await expect(run).rejects.toThrow('- assist');
    await expect(run).rejects.toThrow('- plan');
  });

  it.each([
    ['review', 'archon-review'],
    ['vestig', 'archon-investigate'],
    ['ARCHON-REVIEW', 'archon-review'],
  ])('rejects non-exact %s with suggestions', async (requested, candidate) => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: candidate })],
      errors: [],
    });

    const run = workflowRunCommand(createTestWorkflowHost(), '/test/path', requested, 'hello');
    await expect(run).rejects.toThrow(`Workflow '${requested}' not found`);
    await expect(run).rejects.toThrow(`Did you mean:\n  - ${candidate}`);
  });

  it('suggests names on an exact miss despite a differently cased load error', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'archon-review' })],
      errors: [
        {
          filename: '/workflows/duplicate.yaml',
          workflowName: 'ARCHON-REVIEW',
          error: "Duplicate workflow name 'ARCHON-REVIEW'",
          errorType: 'validation_error',
        },
      ],
    });

    const run = workflowRunCommand(
      createTestWorkflowHost(),
      '/test/path',
      'Archon-review',
      'hello'
    );
    await expect(run).rejects.toThrow("Workflow 'Archon-review' not found");
    await expect(run).rejects.toThrow('Did you mean:\n  - archon-review');
  });

  it('should throw error when workflow execution fails', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: false,
      error: 'Step failed: assist',
    });

    // Use --no-worktree since no codebase is available (isolation would error)
    await expect(
      workflowRunCommand(createTestWorkflowHost(), '/test/path', 'assist', 'hello', {
        noWorktree: true,
      })
    ).rejects.toThrow('Workflow failed: Step failed: assist');
  });
});
