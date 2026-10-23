import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import {
  captureError,
  firstJsonPayload,
  mockDiscoverWorkflowsWithConfig,
  spyOnJsonStdout,
} from '../test-support/workflow-command-harness';
import { providerRegistry } from '@archon/providers';
import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import type { RunFixturesOptions } from '@archon/workflows/fixture-runner';
import { workflowListCommand, workflowTestCommand } from './workflow-query';

describe('workflowListCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('should display message when no workflows found', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [],
      errors: [],
    });

    await workflowListCommand('/test/path');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Discovering workflows'));
    expect(consoleSpy).toHaveBeenCalledWith('\nNo workflows found.');
  });

  it('should list workflows with names and descriptions', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist', description: 'General assistance workflow' }),
        makeTestWorkflowWithSource({
          name: 'plan',
          description: 'Create implementation plan',
          provider: 'claude',
        }),
      ],
      errors: [],
    });

    await workflowListCommand('/test/path');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Found 2 workflow(s)'));
    expect(consoleSpy).toHaveBeenCalledWith('  assist');
    expect(consoleSpy).toHaveBeenCalledWith('    General assistance workflow');
    expect(consoleSpy).toHaveBeenCalledWith('  plan');
    expect(consoleSpy).toHaveBeenCalledWith('    Create implementation plan');
    expect(consoleSpy).toHaveBeenCalledWith('    Provider: claude');
  });

  it('should output JSON when json flag is true', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist', description: 'General assistance workflow' }),
        makeTestWorkflowWithSource({
          name: 'plan',
          description: 'Create implementation plan',
          provider: 'claude',
        }),
      ],
      errors: [],
    });

    await workflowListCommand('/test/path', { json: true });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = firstJsonPayload(stdoutSpy);
    const parsed = JSON.parse(output) as { workflows: unknown[]; errors: unknown[] };
    expect(parsed.workflows).toHaveLength(2);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.workflows[0]).toEqual({
      name: 'assist',
      description: 'General assistance workflow',
      descriptionTruncated: false,
    });
    expect(parsed.workflows[1]).toEqual({
      name: 'plan',
      description: 'Create implementation plan',
      descriptionTruncated: false,
      provider: 'claude',
    });
  });

  it('marks and bounds long descriptions in JSON discovery output', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const description = `Choose this workflow for focused fixes.\n\n${'Detailed routing constraints. '.repeat(20)}`;
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'fix', description })],
      errors: [],
    });

    await workflowListCommand('/test/path', { json: true });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      workflows: Array<{ description: string; descriptionTruncated: boolean }>;
    };
    expect(parsed.workflows[0]).toMatchObject({
      description: 'Choose this workflow for focused fixes.',
      descriptionTruncated: true,
    });
    expect(parsed.workflows[0].description).not.toContain('Detailed routing constraints');
  });

  it('preserves short descriptions byte-for-byte', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const description = 'Keep this short description\n\nexactly as authored.';
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'short', description })],
      errors: [],
    });

    await workflowListCommand('/test/path', { json: true });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      workflows: Array<{ description: string; descriptionTruncated: boolean }>;
    };
    expect(parsed.workflows[0].description).toBe(description);
    expect(parsed.workflows[0].descriptionTruncated).toBe(false);
  });

  it('does not infer JSON truncation state from authored description text', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const description = 'Use when the authored label ends in [truncated]';
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'literal-marker', description })],
      errors: [],
    });

    await workflowListCommand('/test/path', { json: true });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      workflows: Array<{ description: string; descriptionTruncated: boolean }>;
    };
    expect(parsed.workflows[0]).toMatchObject({
      description,
      descriptionTruncated: false,
    });
  });

  it('uses the same bounded preview in human-readable output', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const description = `Choose this workflow for focused fixes.\n\n${'Detailed routing constraints. '.repeat(20)}`;
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'fix', description })],
      errors: [],
    });

    await workflowListCommand('/test/path');

    expect(consoleSpy).toHaveBeenCalledWith(
      '    Choose this workflow for focused fixes. [truncated]'
    );
    expect(consoleSpy.mock.calls.flat().join('\n')).not.toContain('Detailed routing constraints');
  });

  it('caps fallback previews at Unicode code-point and word boundaries', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const emojiPrefix = '🙂'.repeat(150);
    const description = `${emojiPrefix} boundaryword continues without punctuation`;
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'unicode', description })],
      errors: [],
    });

    await workflowListCommand('/test/path', { json: true });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      workflows: Array<{ description: string; descriptionTruncated: boolean }>;
    };
    expect(parsed.workflows[0].description).toBe(emojiPrefix);
    expect(parsed.workflows[0].descriptionTruncated).toBe(true);
    expect(parsed.workflows[0].description).not.toContain('\uFFFD');
    expect(Array.from(parsed.workflows[0].description)).toHaveLength(150);
  });

  it('returns untouched descriptions for the full catalog', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const description = `Choose this workflow first.\n\n${'Keep every detail. '.repeat(20)}`;
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'long', description }),
        makeTestWorkflowWithSource({ name: 'short', description: 'Short description' }),
      ],
      errors: [],
    });

    await workflowListCommand('/test/path', { json: true, full: true });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      workflows: Array<{
        name: string;
        description: string;
        descriptionTruncated: boolean;
      }>;
    };
    expect(parsed.workflows).toEqual([
      { name: 'long', description, descriptionTruncated: false },
      { name: 'short', description: 'Short description', descriptionTruncated: false },
    ]);
  });

  it('prints only the selected workflow untouched in human full-detail output', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const description = `Choose this workflow first.\n\n${'Keep every detail. '.repeat(20)}`;
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'selected', description }),
        makeTestWorkflowWithSource({ name: 'other', description: 'Other workflow' }),
      ],
      errors: [],
    });

    await workflowListCommand('/test/path', { name: 'selected', full: true });

    expect(consoleSpy).toHaveBeenCalledWith('  selected');
    expect(consoleSpy).toHaveBeenCalledWith(`    ${description}`);
    expect(consoleSpy.mock.calls.flat().join('\n')).not.toContain('other');
    expect(consoleSpy.mock.calls.flat().join('\n')).not.toContain(' [truncated]');
  });

  it('filters by workflow name while preserving metadata, warnings, and discovery errors', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const description = `Complete workflow description.\n\n${'Detailed constraint. '.repeat(20)}`;
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist' }),
        makeTestWorkflowWithSource(
          {
            name: 'archon-plan',
            description,
            provider: 'codex',
            model: 'gpt-5.6-sol',
            effort: 'high',
            webSearchMode: 'live',
          },
          'project',
          ["Node 'plan': unknown key 'interactive' will be ignored."]
        ),
      ],
      errors: [{ filename: 'bad.yaml', error: 'Invalid YAML', errorType: 'parse_error' }],
    });

    await workflowListCommand('/test/path', { json: true, name: 'archon-plan', full: true });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      workflows: unknown[];
      errors: unknown[];
    };
    expect(parsed.workflows).toEqual([
      {
        name: 'archon-plan',
        description,
        descriptionTruncated: false,
        provider: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        webSearchMode: 'live',
        parseWarnings: ["Node 'plan': unknown key 'interactive' will be ignored."],
      },
    ]);
    expect(parsed.errors).toEqual([
      { filename: 'bad.yaml', error: 'Invalid YAML', errorType: 'parse_error' },
    ]);
  });

  it('fails when a requested workflow name is missing', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'acme-assist' }),
        makeTestWorkflowWithSource({ name: 'archon-plan' }),
      ],
      errors: [],
    });

    await expect(workflowListCommand('/test/path', { name: 'missing' })).rejects.toThrow(
      "Workflow 'missing' not found.\n\nAvailable workflows:\n  - acme-assist\n  - archon-plan"
    );
  });

  it('carries discovery errors when a requested workflow name is missing', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const loadError = {
      filename: 'bad.yaml',
      error: 'Invalid YAML',
      errorType: 'parse_error' as const,
    };
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'archon-plan' })],
      errors: [loadError],
    });

    const error = await captureError(
      workflowListCommand('/test/path', { name: 'missing', json: true })
    );

    expect(error).toMatchObject({ loadErrors: [loadError] });
  });

  it('fails when a requested workflow name is ambiguous', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'archon-review' }),
        makeTestWorkflowWithSource({ name: 'custom-review' }),
      ],
      errors: [],
    });

    await expect(workflowListCommand('/test/path', { name: 'review' })).rejects.toThrow(
      "Ambiguous workflow 'review'"
    );
  });

  it('carries discovery errors when a requested workflow name is ambiguous', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const loadError = {
      filename: 'bad.yaml',
      error: 'Invalid YAML',
      errorType: 'parse_error' as const,
    };
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'archon-review' }),
        makeTestWorkflowWithSource({ name: 'custom-review' }),
      ],
      errors: [loadError],
    });

    const error = await captureError(
      workflowListCommand('/test/path', { name: 'review', json: true })
    );

    expect(error).toMatchObject({ loadErrors: [loadError] });
  });

  it('reduces catalogs dominated by long descriptions by at least 10x', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const workflows = Array.from({ length: 20 }, (_, index) =>
      makeTestWorkflowWithSource({
        name: `workflow-${String(index).padStart(2, '0')}`,
        description: `Route suitable work here. ${'Detailed routing constraint '.repeat(200)}`,
      })
    );
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>)
      .mockResolvedValueOnce({ workflows, errors: [] })
      .mockResolvedValueOnce({ workflows, errors: [] });

    await workflowListCommand('/test/path', { json: true });
    await workflowListCommand('/test/path', { json: true, full: true });

    const compactBytes = Buffer.byteLength(
      (stdoutSpy.mock.calls[0]?.[0] as string | undefined) ?? '',
      'utf8'
    );
    const fullBytes = Buffer.byteLength(
      (stdoutSpy.mock.calls[1]?.[0] as string | undefined) ?? '',
      'utf8'
    );
    expect(fullBytes / compactBytes).toBeGreaterThanOrEqual(10);
  });

  it('should include errors in JSON output', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [],
      errors: [{ filename: 'bad.yaml', error: 'Invalid YAML', errorType: 'parse_error' }],
    });

    await workflowListCommand('/test/path', { json: true });

    const output = firstJsonPayload(stdoutSpy);
    const parsed = JSON.parse(output) as {
      workflows: unknown[];
      errors: Array<{ filename: string; error: string; errorType: string }>;
    };
    expect(parsed.workflows).toHaveLength(0);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toEqual({
      filename: 'bad.yaml',
      error: 'Invalid YAML',
      errorType: 'parse_error',
    });
  });

  it('should include effort and webSearchMode in JSON output when present', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'plan',
          description: 'Planning workflow',
          provider: 'codex',
          model: 'gpt-5.6-sol',
          // #2556: `effort:` is the one spelling. The deprecated field is
          // translated into it at load, so it can never reach this surface.
          effort: 'xhigh',
          webSearchMode: 'live',
        }),
      ],
      errors: [],
    });

    await workflowListCommand('/test/path', { json: true });

    const output = firstJsonPayload(stdoutSpy);
    const parsed = JSON.parse(output) as {
      workflows: Array<Record<string, string | boolean>>;
      errors: unknown[];
    };
    expect(parsed.workflows[0]).toEqual({
      name: 'plan',
      description: 'Planning workflow',
      descriptionTruncated: false,
      provider: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      webSearchMode: 'live',
    });
  });

  it('should produce text output when json flag is false', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist', description: 'General assistance' }),
      ],
      errors: [],
    });

    await workflowListCommand('/test/path', { json: false });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Discovering workflows'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Found 1 workflow(s)'));
  });

  it('calls discoverWorkflowsWithConfig with (cwd, loadConfig) — home scope is internal', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [],
      errors: [],
    });

    await workflowListCommand('/test/path');

    // After the globalSearchPath refactor, discovery reads ~/.archon/workflows/
    // on every call with no option — every caller inherits home-scope for free.
    expect(discoverWorkflowsWithConfig).toHaveBeenCalledWith(
      '/test/path',
      expect.any(Function),
      providerRegistry
    );
  });

  it('should throw error when discoverWorkflows fails', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('Permission denied')
    );

    await expect(workflowListCommand('/test/path')).rejects.toThrow(
      'Error loading workflows: Permission denied'
    );
  });

  // #2213 — a key the engine drops has to reach the author on the surface they
  // use, not only in `archon validate workflows` (which nothing requires them
  // to run).
  it('prints parse warnings inline with the workflow that raised them', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'clean' }, 'project'),
        makeTestWorkflowWithSource({ name: 'gated' }, 'project', [
          "Node 'plan': unknown key 'interactive' will be ignored.",
        ]),
      ],
      errors: [],
    });

    await workflowListCommand('/test/path');

    expect(consoleSpy).toHaveBeenCalledWith(
      "    Warning: Node 'plan': unknown key 'interactive' will be ignored."
    );
  });

  it('carries parse warnings in --json output', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'clean' }, 'project'),
        makeTestWorkflowWithSource({ name: 'gated' }, 'project', ["dropped 'interactive'"]),
      ],
      errors: [],
    });

    await workflowListCommand('/test/path', { json: true });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      workflows: { name: string; parseWarnings?: string[] }[];
    };
    // Absent (not an empty array) on a clean workflow, so the field's presence
    // alone is the signal.
    expect(parsed.workflows[0].parseWarnings).toBeUndefined();
    expect(parsed.workflows[1].parseWarnings).toEqual(["dropped 'interactive'"]);
  });
});

describe('workflowTestCommand', () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    stdoutSpy = spyOnJsonStdout();
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    const gitModule = await import('@archon/git');
    (gitModule.findRepoRoot as ReturnType<typeof mock>).mockReset().mockResolvedValue(null);
    mockDiscoverWorkflowsWithConfig.mockClear();
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockClear();
    (fixtureRunner.formatFixtureReport as ReturnType<typeof mock>).mockClear();
    mockDiscoverWorkflowsWithConfig.mockResolvedValue({
      workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
      errors: [],
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('emits one JSON document and exits 0 when every fixture passes', async () => {
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockResolvedValue({
      results: [
        {
          fixture: 'sdlc/plan/fixtures/ready.stubs.yaml',
          workflow: 'plan',
          expect: 'completed',
          outcome: 'completed',
          pass: true,
          missingStubs: [],
          toleratedMissingStubs: [],
          unusedStubs: ['spare'],
        },
      ],
      passed: 1,
      failed: 0,
    });

    const exit = await workflowTestCommand('/test/path', undefined, { json: true });

    expect(exit).toBe(0);
    expect(fixtureRunner.runFixtures).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/test/path' })
    );
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(firstJsonPayload(stdoutSpy));
    expect(payload.passed).toBe(1);
    expect(payload.failed).toBe(0);
    expect(payload.results[0]).toMatchObject({ fixture: 'sdlc/plan/fixtures/ready.stubs.yaml' });
  });

  it('discovers workflows at the repository root while resolving targets from the invoking directory', async () => {
    const gitModule = await import('@archon/git');
    (gitModule.findRepoRoot as ReturnType<typeof mock>).mockResolvedValueOnce('/test/repository');
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockResolvedValue({
      results: [],
      passed: 0,
      failed: 0,
    });

    await workflowTestCommand('/test/repository/tools', '../.archon/workflows/local-pack');

    expect(gitModule.findRepoRoot).toHaveBeenCalledWith('/test/repository/tools');
    expect(mockDiscoverWorkflowsWithConfig).toHaveBeenCalledWith(
      '/test/repository',
      expect.any(Function),
      providerRegistry
    );
    expect(fixtureRunner.runFixtures).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/test/repository', targetCwd: '/test/repository/tools' })
    );
  });

  it('exits 1 when a fixture fails', async () => {
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockResolvedValue({
      results: [
        {
          fixture: 'f.stubs.yaml',
          workflow: 'plan',
          expect: 'completed',
          outcome: 'failed',
          pass: false,
          failureReason: 'expected completed, dry-run reported failed',
          missingStubs: [],
          toleratedMissingStubs: [],
          unusedStubs: [],
        },
      ],
      passed: 0,
      failed: 1,
    });

    const exit = await workflowTestCommand('/test/path', 'plan');
    expect(exit).toBe(1);
  });

  it('exits 1 when an explicitly named target has no fixtures', async () => {
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockResolvedValue({
      results: [],
      passed: 0,
      failed: 0,
    });

    const exit = await workflowTestCommand('/test/path', 'no-fixtures');
    expect(exit).toBe(1);
  });

  it('exits 0 with no fixtures when no target was named', async () => {
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockResolvedValue({
      results: [],
      passed: 0,
      failed: 0,
    });

    const exit = await workflowTestCommand('/test/path', undefined);
    expect(exit).toBe(0);
    expect(fixtureRunner.formatFixtureReport).toHaveBeenCalled();
  });

  it('reports load failures alongside passing fixture results and exits 1', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
      errors: [
        {
          filename: 'broken.yaml',
          error: 'YAML parse error: unexpected end of document',
          errorType: 'parse_error',
        },
      ],
    });
    (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockResolvedValue({
      results: [],
      passed: 1,
      failed: 0,
    });

    const exit = await workflowTestCommand('/test/path', undefined);

    expect(exit).toBe(1);
    expect(fixtureRunner.runFixtures).toHaveBeenCalledWith(
      expect.objectContaining({
        workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
      })
    );
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy.mock.calls[0]?.[0]).toBe(
      'FIXTURE REPORT\n\n1 workflow(s) failed to load:\n\n  broken.yaml: YAML parse error: unexpected end of document\n'
    );
  });

  it('includes load failures in JSON fixture reports and exits 1', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    const error = {
      filename: 'broken.yaml',
      error: 'YAML parse error: unexpected end of document',
      errorType: 'parse_error' as const,
    };
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
      errors: [error],
    });
    (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockResolvedValue({
      results: [],
      passed: 1,
      failed: 0,
    });

    const exit = await workflowTestCommand('/test/path', undefined, { json: true });

    expect(exit).toBe(1);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toEqual({
      results: [],
      passed: 1,
      failed: 0,
      errors: [error],
    });
  });

  it('reports load failures when fixture target selection fails', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [],
      errors: [
        {
          filename: 'broken.yaml',
          error: 'YAML parse error: unexpected end of document',
          errorType: 'parse_error',
        },
      ],
    });
    (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error("No fixtures found for 'missing'.")
    );

    const exit = await workflowTestCommand('/test/path', 'missing');

    expect(exit).toBe(1);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy.mock.calls[0]?.[0]).toBe(
      "Error: No fixtures found for 'missing'.\n\n1 workflow(s) failed to load:\n\n  broken.yaml: YAML parse error: unexpected end of document\n"
    );
  });

  it('includes load failures when fixture target selection fails in JSON', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    const error = {
      filename: 'broken.yaml',
      error: 'YAML parse error: unexpected end of document',
      errorType: 'parse_error' as const,
    };
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [],
      errors: [error],
    });
    (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error("No fixtures found for 'missing'.")
    );

    const exit = await workflowTestCommand('/test/path', 'missing', { json: true });

    expect(exit).toBe(1);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toEqual({
      ok: false,
      error: "No fixtures found for 'missing'.",
      errors: [error],
    });
  });

  it('reports no fixtures without consulting an unavailable environment store', async () => {
    const codebases = await import('@archon/core/db/codebases');
    const lookup = spyOn(codebases, 'findCodebaseByDefaultCwd').mockResolvedValue({
      id: 'cb-env',
      name: 'env',
      kind: 'repo',
      default_cwd: '/test/path',
      repository_url: null,
      default_branch: null,
      ai_assistant_type: null,
      commands: {},
      created_at: new Date(0),
      updated_at: new Date(0),
    });
    const envVars = await import('@archon/core/db/env-vars');
    const env = spyOn(envVars, 'getCodebaseEnvVars').mockRejectedValue(
      new Error('store unavailable')
    );
    env.mockClear();
    try {
      const fixtureRunner = await import('@archon/workflows/fixture-runner');
      (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockResolvedValueOnce({
        results: [],
        passed: 0,
        failed: 0,
      });
      expect(await workflowTestCommand('/test/path', undefined, { json: true })).toBe(0);
      expect(env).not.toHaveBeenCalled();
      expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
        results: [],
        passed: 0,
        failed: 0,
      });
    } finally {
      lookup.mockRestore();
      env.mockRestore();
    }
  });

  it('passes registered environment and redaction provenance to executable fixtures', async () => {
    const codebases = await import('@archon/core/db/codebases');
    const lookup = spyOn(codebases, 'findCodebaseByDefaultCwd').mockResolvedValue({
      id: 'cb-env',
      name: 'env',
      kind: 'repo',
      default_cwd: '/test/path',
      repository_url: null,
      default_branch: null,
      ai_assistant_type: null,
      commands: {},
      created_at: new Date(0),
      updated_at: new Date(0),
    });
    const envVars = await import('@archon/core/db/env-vars');
    const env = spyOn(envVars, 'getCodebaseEnvVars').mockResolvedValue({
      ARCHON_DB_DIAGNOSTIC: 'db-value',
    });
    try {
      expect(process.env.ARCHON_DB_DIAGNOSTIC).toBeUndefined();
      const core = await import('@archon/core');
      (core.loadConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        assistant: 'claude',
        assistants: {},
        commands: {},
        envVars: { ARCHON_DB_DIAGNOSTIC: 'file-value', FILE_ONLY: 'kept' },
      });
      const fixtureRunner = await import('@archon/workflows/fixture-runner');
      let resolvedConfig:
        | Awaited<ReturnType<NonNullable<RunFixturesOptions['resolveExecConfig']>>>
        | undefined;
      (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockImplementationOnce(
        async (options: RunFixturesOptions) => {
          expect(env).not.toHaveBeenCalled();
          resolvedConfig = await options.resolveExecConfig?.();
          return { results: [], passed: 0, failed: 0 };
        }
      );
      await workflowTestCommand('/test/path', undefined);
      expect(env).toHaveBeenCalledWith('cb-env');
      expect(resolvedConfig).toEqual(
        expect.objectContaining({
          envVars: { ARCHON_DB_DIAGNOSTIC: 'db-value', FILE_ONLY: 'kept' },
          protectedCredentialValues: ['db-value'],
        })
      );
    } finally {
      lookup.mockRestore();
      env.mockRestore();
    }
  });

  it("freezes the repo's own command policy, not the default folders (#2851)", async () => {
    // The capture decides which directories a fixture can resolve a command from, so a
    // repo that moved `commands.folder` must have THAT folder frozen. Reading the value
    // here is the only place it can be read; `runFixtures` cannot load config itself.
    const core = await import('@archon/core');
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    expect(process.env.ARCHON_CLI_CONFIGURED_VALUE).toBeUndefined();
    (core.loadConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      commands: { folder: '.archon/prompts' },
      defaults: { loadDefaultCommands: false },
      envVars: { ARCHON_CLI_CONFIGURED_VALUE: 'configured-value' },
      protectedEnvKeys: ['ACCOUNT'],
      protectedCredentialValues: ['synthetic-cli-value'],
    });
    (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockResolvedValue({
      results: [],
      passed: 0,
      failed: 0,
    });

    await workflowTestCommand('/test/path', undefined);

    expect(fixtureRunner.runFixtures).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          envVars: { ARCHON_CLI_CONFIGURED_VALUE: 'configured-value' },
          protectedEnvKeys: ['ACCOUNT'],
          protectedCredentialValues: ['synthetic-cli-value'],
        }),
        sourceConfig: {
          load_default_workflows: true,
          load_default_commands: false,
          command_folder: '.archon/prompts',
          env_var_names: ['ARCHON_CLI_CONFIGURED_VALUE'],
        },
      })
    );
  });

  it('fails the fixture run when the config is unreadable instead of freezing defaults', async () => {
    // `loadConfig` returns defaults when there is no config file, so a throw means a
    // MALFORMED one. Proceeding would capture the standard folders and report green on
    // fixtures whose commands the real run would never find.
    const core = await import('@archon/core');
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    (core.loadConfig as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('bad yaml at .archon/config.yaml:7')
    );

    await expect(workflowTestCommand('/test/path', undefined)).rejects.toThrow(/bad yaml/);
    expect(fixtureRunner.runFixtures).not.toHaveBeenCalled();
  });
});
