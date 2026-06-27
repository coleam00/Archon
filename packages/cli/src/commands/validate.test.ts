import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const mockDiscoverWorkflowsWithConfig = mock(() => Promise.resolve({ workflows: [], errors: [] }));

mock.module('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mockDiscoverWorkflowsWithConfig,
}));

const mockLoadRepoConfig = mock(() => Promise.resolve(null));
const mockLoadConfig = mock(() =>
  Promise.resolve({
    assistant: 'claude',
    aliases: {},
    tiers: {},
  })
);

mock.module('@archon/core', () => ({
  loadConfig: mockLoadConfig,
  loadRepoConfig: mockLoadRepoConfig,
}));

import { validateWorkflowsCommand } from './validate';

describe('validateWorkflowsCommand', () => {
  const originalLog = console.log;
  const originalError = console.error;
  const mockConsoleLog = mock(() => {});
  const mockConsoleError = mock(() => {});

  beforeEach(() => {
    mockDiscoverWorkflowsWithConfig.mockClear();
    mockLoadRepoConfig.mockClear();
    mockLoadConfig.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    console.log = mockConsoleLog;
    console.error = mockConsoleError;
    mockLoadRepoConfig.mockResolvedValue(null);
    mockLoadConfig.mockResolvedValue({
      assistant: 'claude',
      aliases: {},
      tiers: {},
    });
  });

  test('rejects bundled @custom model refs via discovered source', async () => {
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [
        {
          source: 'bundled',
          workflow: {
            name: 'bad-bundled',
            model: '@custom',
            nodes: [{ id: 'step1', prompt: 'hello' }],
          },
        },
      ],
      errors: [],
    });

    const exitCode = await validateWorkflowsCommand('/tmp/repo', undefined, true);

    expect(exitCode).toBe(1);
    expect(JSON.stringify(mockConsoleLog.mock.calls)).toContain('@custom');
  });

  test.skip('[ATDD][P1] validate workflows surfaces route_loop loader errors through the first-party CLI consumer contract', async () => {
    // Skip reason: current validate command tests mock workflow discovery.
    // Activate after Story 1.1 and Story 1.2 land by replacing this mock with a real temp .archon/workflows route_loop fixture.
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [],
      errors: [
        {
          filename: 'route-loop-source.yaml',
          errorType: 'validation_error',
          error:
            "Node 'review-router': route_loop.from is required and depends_on must contain exactly route_loop.from",
        },
      ],
    });

    const exitCode = await validateWorkflowsCommand('/tmp/repo', undefined, true);

    expect(exitCode).toBe(1);
    const output = JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0])) as {
      results: Array<{
        workflowName: string;
        issues: Array<{ field: string; message: string }>;
      }>;
      summary: { errors: number; valid: number };
    };
    expect(output.summary.errors).toBe(1);
    expect(output.summary.valid).toBe(0);
    expect(output.results[0].workflowName).toBe('route-loop-source');
    expect(output.results[0].issues[0].field).toBe('validation_error');
    expect(output.results[0].issues[0].message).toContain('route_loop.from');
    expect(output.results[0].issues[0].message).toContain('depends_on');
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
  });
});
