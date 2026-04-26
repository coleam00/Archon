import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';

const mockLogger = {
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  fatal: mock(() => undefined),
};

const mockFindActiveByBranchName = mock(() => Promise.resolve(null));
const mockFindLatestRunByWorkingPath = mock(() => Promise.resolve(null));
const mockWorkflowRunCommand = mock(() => Promise.resolve());
const mockExecFileAsync = mock(() => Promise.resolve({ stdout: '' }));

mock.module('@harneeslab/core/db/isolation-environments', () => ({
  findActiveByBranchName: mockFindActiveByBranchName,
}));

mock.module('@harneeslab/core/db/codebases', () => ({
  getCodebase: mock(() => Promise.resolve(null)),
}));

mock.module('@harneeslab/core/db/workflows', () => ({
  findLatestRunByWorkingPath: mockFindLatestRunByWorkingPath,
}));

mock.module('@harneeslab/git', () => ({
  execFileAsync: mockExecFileAsync,
}));

mock.module('@harneeslab/paths', () => ({
  createLogger: mock(() => mockLogger),
  getRunArtifactsPath: mock(() => '/tmp/hlab-artifacts'),
  parseOwnerRepo: mock(() => null),
}));

mock.module('./workflow', () => ({
  workflowRunCommand: mockWorkflowRunCommand,
}));

import { continueCommand } from './continue';

describe('continueCommand', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockFindActiveByBranchName.mockReset();
    mockFindLatestRunByWorkingPath.mockReset();
    mockWorkflowRunCommand.mockReset();
    mockExecFileAsync.mockReset();
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('reports missing active worktree in Korean while preserving hlab command syntax', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(null);

    await expect(continueCommand('feature/missing', '이어가기')).rejects.toThrow(
      "branch 'feature/missing'의 활성 worktree를 찾지 못했습니다.\n사용 가능한 worktree는 'hlab isolation list'로 확인하세요."
    );
  });

  it('prints Korean progress labels and delegates to workflow run without spawning setup', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce({
      working_path: '/repo/worktree',
      codebase_id: 'codebase-1',
    });
    mockFindLatestRunByWorkingPath.mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'archon-assist',
      status: 'completed',
    });
    mockExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('--abbrev-ref')) return Promise.resolve({ stdout: 'feature/test\n' });
      return Promise.resolve({ stdout: '' });
    });
    mockWorkflowRunCommand.mockResolvedValueOnce(undefined);

    await continueCommand('feature/test', '다음 작업', { workflow: 'archon-assist' });

    expect(consoleLogSpy).toHaveBeenCalledWith('branch에서 계속 진행: feature/test');
    expect(consoleLogSpy).toHaveBeenCalledWith('Workflow: archon-assist');
    expect(consoleLogSpy).toHaveBeenCalledWith('Path: /repo/worktree');
    expect(consoleLogSpy).toHaveBeenCalledWith('이전 run: run-1 (archon-assist, completed)');
    expect(mockWorkflowRunCommand).toHaveBeenCalledWith(
      '/repo/worktree',
      'archon-assist',
      expect.stringContaining('## 사용자 지시\n\n다음 작업'),
      { noWorktree: true, codebaseId: 'codebase-1' }
    );
  });
});
