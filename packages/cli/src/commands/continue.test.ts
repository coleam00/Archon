import { describe, test, expect, mock, beforeEach, spyOn } from 'bun:test';
import { continueCommand } from './continue';

const mockWorkflowRunCommand = mock(async () => {});
const mockFindActiveByBranchName = mock(async () => ({
  codebase_id: 'cb-1',
  working_path: '/tmp/project',
  branch_name: 'feature/test',
}));
const mockGetCodebase = mock(async () => ({
  id: 'cb-1',
  ai_assistant_type: 'claude',
}));
const mockLoadConfig = mock(async () => ({ assistant: 'claude' }));
const mockFindLatestRunByWorkingPath = mock(async () => null);

mock.module('./workflow', () => ({
  workflowRunCommand: mockWorkflowRunCommand,
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  findActiveByBranchName: mockFindActiveByBranchName,
}));

mock.module('@archon/core/db/codebases', () => ({
  getCodebase: mockGetCodebase,
}));

mock.module('@archon/core/db/workflows', () => ({
  findLatestRunByWorkingPath: mockFindLatestRunByWorkingPath,
}));

mock.module('@archon/core', () => ({
  loadConfig: mockLoadConfig,
}));

mock.module('@archon/git', () => ({
  execFileAsync: mock(async () => ({ stdout: '', stderr: '' })),
}));

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
  }),
  getRunArtifactsPath: mock(() => '/tmp/artifacts'),
  parseOwnerRepo: mock(() => null),
}));

describe('continueCommand', () => {
  const consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    mockWorkflowRunCommand.mockClear();
    mockFindActiveByBranchName.mockClear();
    mockGetCodebase.mockClear();
    mockLoadConfig.mockClear();
    mockFindLatestRunByWorkingPath.mockClear();
    consoleLogSpy.mockClear();
  });

  test('defaults to Claude assist workflow for Claude codebases', async () => {
    mockGetCodebase.mockResolvedValueOnce({ id: 'cb-1', ai_assistant_type: 'claude' });

    await continueCommand('feature/test', 'continue please', { noContext: true });

    expect(mockWorkflowRunCommand).toHaveBeenCalledWith(
      '/tmp/project',
      'archon-assist',
      'continue please',
      expect.objectContaining({ noWorktree: true, codebaseId: 'cb-1' })
    );
  });

  test('defaults to Codex assist workflow for Codex codebases', async () => {
    mockGetCodebase.mockResolvedValueOnce({ id: 'cb-1', ai_assistant_type: 'codex' });

    await continueCommand('feature/test', 'continue please', { noContext: true });

    expect(mockWorkflowRunCommand).toHaveBeenCalledWith(
      '/tmp/project',
      'archon-assist-codex',
      'continue please',
      expect.objectContaining({ noWorktree: true, codebaseId: 'cb-1' })
    );
  });

  test('falls back to config when codebase assistant is unavailable', async () => {
    mockGetCodebase.mockResolvedValueOnce(null);
    mockLoadConfig.mockResolvedValueOnce({ assistant: 'codex' });

    await continueCommand('feature/test', 'continue please', { noContext: true });

    expect(mockWorkflowRunCommand).toHaveBeenCalledWith(
      '/tmp/project',
      'archon-assist-codex',
      'continue please',
      expect.objectContaining({ noWorktree: true, codebaseId: 'cb-1' })
    );
  });

  test('respects explicit workflow override', async () => {
    mockGetCodebase.mockResolvedValueOnce({ id: 'cb-1', ai_assistant_type: 'codex' });

    await continueCommand('feature/test', 'continue please', {
      noContext: true,
      workflow: 'archon-smart-pr-review',
    });

    expect(mockWorkflowRunCommand).toHaveBeenCalledWith(
      '/tmp/project',
      'archon-smart-pr-review',
      'continue please',
      expect.objectContaining({ noWorktree: true, codebaseId: 'cb-1' })
    );
  });
});
