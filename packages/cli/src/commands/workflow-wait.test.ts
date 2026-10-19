import {
  mockWaitForRunAttention,
  spyOnJsonStdout,
  spyOnStderr,
  firstJsonPayload,
  createTestWorkflowHost,
} from '../test-support/workflow-command-harness';
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { workflowWaitCommand } from './workflow-query';

describe('workflowWaitCommand', () => {
  const FULL_ID = '0b1ee8da-1111-2222-3333-444455556666';
  let consoleSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
    mockWaitForRunAttention.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  const terminal = (status: string) => ({
    kind: 'attention',
    attention: { kind: 'terminal', runId: FULL_ID, status, at: new Date('2026-08-28T12:00:00Z') },
  });

  it.each([false, true])(
    'returns live tool attention with exit 0 and no resume advice (json=%s)',
    async json => {
      const attention = {
        kind: 'stalled_tool_calls',
        runId: 'child-run',
        status: 'running',
        calls: [
          {
            streamId: 's',
            nodeId: 'implement',
            provider: 'codex',
            toolCallId: 'call',
            name: 'bash',
            title: 'bun test',
            startedAt: '2026-10-01T00:00:00Z',
            lastProgressAt: '2026-10-01T00:00:00Z',
            raisedAt: '2026-10-01T00:30:00Z',
            thresholdMs: 1800000,
            elapsedMs: 1800000,
            stalledForMs: 1800000,
          },
        ],
      };
      mockWaitForRunAttention.mockResolvedValueOnce({ kind: 'attention', attention });
      expect(await workflowWaitCommand(createTestWorkflowHost(), FULL_ID, json, '/repo')).toBe(0);
      if (json)
        expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
          result: 'attention',
          attention,
        });
      else {
        const printed = consoleSpy.mock.calls.flat().join(' ');
        expect(printed).toContain('child-run is still running');
        expect(printed).toContain('implement');
        expect(printed).toContain('bun test');
        expect(printed).toContain('1800s');
        expect(printed).not.toContain('resume');
      }
    }
  );

  it('exits 0 and names the terminal status', async () => {
    mockWaitForRunAttention.mockResolvedValueOnce(terminal('failed'));

    const code = await workflowWaitCommand(createTestWorkflowHost(), FULL_ID, undefined, '/repo');

    expect(code).toBe(0);
    // A failed run is a successful WAIT — mapping run state onto the exit code would
    // make a legitimately cancelled run look like a broken command.
    expect(consoleSpy.mock.calls.flat().join(' ')).toContain(`Run ${FULL_ID} failed.`);
  });

  it('names the child run when the gate lives below the run being watched', async () => {
    mockWaitForRunAttention.mockResolvedValueOnce({
      kind: 'attention',
      attention: {
        kind: 'awaiting_response',
        runId: 'child-9',
        respondTo: { runId: 'child-9', nodeId: 'review' },
        occurrence: 'legacy:review',
        message: 'Approve?',
      },
    });

    const code = await workflowWaitCommand(createTestWorkflowHost(), FULL_ID, undefined, '/repo');

    expect(code).toBe(0);
    const printed = consoleSpy.mock.calls.flat().join(' ');
    expect(printed).toContain('blocked on sub-run child-9');
    expect(printed).toContain("gate 'review'");
  });

  it('sends an attention wait from before answers to resume', async () => {
    mockWaitForRunAttention.mockResolvedValueOnce({
      kind: 'attention',
      attention: {
        kind: 'attention',
        runId: FULL_ID,
        nodeId: 'rerun-ci',
        occurrence: 'legacy:rerun-ci',
        message: 'Re-run CI, then resume.',
        form: 'message',
        options: [],
      },
    });

    const code = await workflowWaitCommand(createTestWorkflowHost(), FULL_ID, undefined, '/repo');

    expect(code).toBe(0);
    const printed = consoleSpy.mock.calls.flat().join(' ');
    expect(printed).toContain('Re-run CI, then resume.');
    expect(printed).toContain(`archon workflow resume ${FULL_ID}`);
  });

  it('names how to answer a multi_select attention wait at its occurrence', async () => {
    mockWaitForRunAttention.mockResolvedValueOnce({
      kind: 'attention',
      attention: {
        kind: 'attention',
        runId: FULL_ID,
        nodeId: 'pick',
        occurrence: 'pause-7',
        message: 'Which checks?',
        form: 'multi_select',
        options: [{ id: 'lint' }, { id: 'test', label: 'Tests' }],
      },
    });

    const code = await workflowWaitCommand(createTestWorkflowHost(), FULL_ID, undefined, '/repo');

    expect(code).toBe(0);
    const printed = consoleSpy.mock.calls.flat().join(' ');
    expect(printed).toContain(`Run ${FULL_ID} needs attention: Which checks?`);
    expect(printed).toContain('Choose one or more of: lint, Tests (test)');
    expect(printed).toContain(
      `archon workflow answer ${FULL_ID} --occurrence pause-7 --choose <id>`
    );
    expect(printed).not.toContain('workflow resume');
  });

  it('exits 3 with the observed status when the deadline passes', async () => {
    mockWaitForRunAttention.mockResolvedValueOnce({
      kind: 'deadline',
      runId: FULL_ID,
      observedStatus: 'running',
    });

    const code = await workflowWaitCommand(createTestWorkflowHost(), FULL_ID, true, '/repo', 5);

    expect(code).toBe(3);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: true,
      action: 'wait',
      runId: FULL_ID,
      result: 'deadline',
      observedStatus: 'running',
    });
    expect(mockWaitForRunAttention).toHaveBeenCalledWith(expect.any(Object), FULL_ID, {
      doorbell: expect.any(Function),
      deadlineMs: 5000,
      onAttached: expect.any(Function),
    });
  });

  it('renders owner loss as an unchanged non-terminal run with an abandon action', async () => {
    mockWaitForRunAttention.mockResolvedValueOnce({
      kind: 'owner_lost',
      runId: FULL_ID,
      observedStatus: 'running',
    });

    const code = await workflowWaitCommand(createTestWorkflowHost(), FULL_ID, undefined, '/repo');

    expect(code).toBe(0);
    const printed = consoleSpy.mock.calls.flat().join(' ');
    expect(printed).toContain(`lost its execution owner while still running`);
    expect(printed).toContain('The run was not changed');
    expect(printed).toContain(`archon workflow abandon ${FULL_ID}`);
  });

  it('emits owner_lost JSON without inventing attention or terminal status', async () => {
    mockWaitForRunAttention.mockResolvedValueOnce({
      kind: 'owner_lost',
      runId: FULL_ID,
      observedStatus: 'paused',
    });

    const code = await workflowWaitCommand(createTestWorkflowHost(), FULL_ID, true, '/repo');
    const payload = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;

    expect(code).toBe(0);
    expect(payload).toEqual({
      ok: true,
      action: 'wait',
      runId: FULL_ID,
      result: 'owner_lost',
      observedStatus: 'paused',
    });
    expect(payload).not.toHaveProperty('status');
    expect(payload).not.toHaveProperty('attention');
  });

  it('announces the attachment on stderr, leaving stdout one --json document', async () => {
    const stderrSpy = spyOnStderr();
    mockWaitForRunAttention.mockImplementationOnce(async (_store, _runId, opts) => {
      await opts?.onAttached?.('running');
      return terminal('cancelled');
    });

    const code = await workflowWaitCommand(createTestWorkflowHost(), FULL_ID, true, '/repo');

    expect(code).toBe(0);
    // stderr is the whole point: a progress line on stdout would break the --json
    // contract that a consumer gets exactly one document.
    expect(stdoutSpy.mock.calls).toHaveLength(1);
    expect(JSON.parse(String(stderrSpy.mock.calls[0]?.[0]))).toEqual({
      ok: true,
      action: 'wait',
      runId: FULL_ID,
      result: 'waiting',
      observedStatus: 'running',
    });
    stderrSpy.mockRestore();
  });

  it('names the run and the status it attached on in human mode', async () => {
    const stderrSpy = spyOnStderr();
    mockWaitForRunAttention.mockImplementationOnce(async (_store, _runId, opts) => {
      await opts?.onAttached?.('paused');
      return terminal('completed');
    });

    await workflowWaitCommand(createTestWorkflowHost(), FULL_ID, undefined, '/repo');

    expect(String(stderrSpy.mock.calls[0]?.[0])).toBe(
      `Waiting on run ${FULL_ID} — currently paused.\n`
    );
    stderrSpy.mockRestore();
  });

  it('says when the owner cannot be checked from this host', async () => {
    const stderrSpy = spyOnStderr();
    const recordedOwner = { host: 'build-2', pid: 4242, uid: 501 };
    const announceUnknown: Parameters<typeof mockWaitForRunAttention.mockImplementation>[0] =
      async (_store, _runId, opts) => {
        await opts?.onAttached?.('running', { kind: 'unknown', recordedOwner });
        return terminal('completed');
      };
    mockWaitForRunAttention.mockImplementationOnce(announceUnknown);
    mockWaitForRunAttention.mockImplementationOnce(announceUnknown);

    await workflowWaitCommand(createTestWorkflowHost(), FULL_ID, true, '/repo');
    await workflowWaitCommand(createTestWorkflowHost(), FULL_ID, undefined, '/repo');

    expect(JSON.parse(String(stderrSpy.mock.calls[0]?.[0]))).toEqual({
      ok: true,
      action: 'wait',
      runId: FULL_ID,
      result: 'waiting',
      observedStatus: 'running',
      ownerLiveness: 'unknown',
      recordedOwner,
    });
    expect(String(stderrSpy.mock.calls[1]?.[0])).toBe(
      `Waiting on run ${FULL_ID} — currently running. Its owner ran on host build-2 (uid 501), whose endpoint this host cannot reach, so whether it is still alive is unknown.\n`
    );
    stderrSpy.mockRestore();
  });

  it('fails the wait when the attachment line cannot be delivered', async () => {
    // The line carries an ordering, so losing it silently is the one outcome that
    // defeats it — and `console.error` to a closed pipe is exactly that no-op.
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation((...args: unknown[]) => {
      const callback = args.find(arg => typeof arg === 'function');
      if (typeof callback === 'function') {
        (callback as (error: Error) => void)(
          Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
        );
      }
      return true;
    });
    mockWaitForRunAttention.mockImplementationOnce(async (_store, _runId, opts) => {
      await opts?.onAttached?.('running');
      return terminal('completed');
    });

    const code = await workflowWaitCommand(createTestWorkflowHost(), FULL_ID, true, '/repo');

    expect(code).toBe(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'wait',
      error: 'write EPIPE',
    });
    stderrSpy.mockRestore();
  });

  it('waits indefinitely when no timeout is given', async () => {
    mockWaitForRunAttention.mockResolvedValueOnce(terminal('completed'));

    await workflowWaitCommand(createTestWorkflowHost(), FULL_ID, undefined, '/repo');

    expect(mockWaitForRunAttention).toHaveBeenCalledWith(expect.any(Object), FULL_ID, {
      doorbell: expect.any(Function),
      onAttached: expect.any(Function),
    });
  });

  it('emits the attention value verbatim under --json', async () => {
    mockWaitForRunAttention.mockResolvedValueOnce({
      kind: 'attention',
      attention: {
        kind: 'awaiting_response',
        runId: FULL_ID,
        respondTo: { runId: FULL_ID, nodeId: 'review' },
        occurrence: 'legacy:review',
        message: 'Approve?',
      },
    });

    const code = await workflowWaitCommand(createTestWorkflowHost(), FULL_ID, true, '/repo');

    expect(code).toBe(0);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toEqual({
      ok: true,
      action: 'wait',
      runId: FULL_ID,
      result: 'attention',
      attention: {
        kind: 'awaiting_response',
        runId: FULL_ID,
        respondTo: { runId: FULL_ID, nodeId: 'review' },
        occurrence: 'legacy:review',
        message: 'Approve?',
      },
    });
  });

  it('resolves a short prefix before waiting (#2871 defect class)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'proj',
      default_cwd: '/repo',
    });
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: FULL_ID },
    ]);
    mockWaitForRunAttention.mockResolvedValueOnce(terminal('completed'));

    const code = await workflowWaitCommand(
      createTestWorkflowHost(),
      '0b1ee8da',
      undefined,
      '/repo'
    );

    expect(code).toBe(0);
    expect(mockWaitForRunAttention).toHaveBeenCalledWith(expect.any(Object), FULL_ID, {
      doorbell: expect.any(Function),
      onAttached: expect.any(Function),
    });
  });

  it('never throws in --json mode when the wait itself fails', async () => {
    mockWaitForRunAttention.mockRejectedValueOnce(new Error('database unreachable'));

    const code = await workflowWaitCommand(createTestWorkflowHost(), FULL_ID, true, '/repo');

    expect(code).toBe(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'wait',
      error: 'database unreachable',
    });
  });

  it('throws in human mode when the wait itself fails', async () => {
    mockWaitForRunAttention.mockRejectedValueOnce(new Error('database unreachable'));

    await expect(
      workflowWaitCommand(createTestWorkflowHost(), FULL_ID, undefined, '/repo')
    ).rejects.toThrow('Failed to wait for workflow run: database unreachable');
  });
});
