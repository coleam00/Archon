import { describe, expect, mock, test } from 'bun:test';
import {
  TERMINAL_WORKFLOW_STATUSES,
  CONTINUATION_MODES,
} from '@archon/workflows/schemas/workflow-run';
import { workflowRunStatusSchema } from '@archon/workflows/schemas/run-status';
import type { IWorkflowStore } from '@archon/workflows/store';
import { makeRun } from '../test/orchestrator-agent-fixtures';
import { resolveRunContinuation, WorkflowContinuationError } from './workflow-continuation';

const fullId = '12345678-1234-1234-1234-123456789abc';
function fixture() {
  const run = makeRun({ id: fullId, status: 'failed' });
  const store = {
    getWorkflowRun: mock<IWorkflowStore['getWorkflowRun']>(async id =>
      id === fullId ? run : null
    ),
    findWorkflowRunsByIdPrefix: mock<IWorkflowStore['findWorkflowRunsByIdPrefix']>(
      async (ref, project) => (project === run.codebase_id && run.id.startsWith(ref) ? [run] : [])
    ),
  };
  return { store, run, codebaseId: 'codebase-1' };
}

describe('continuation resolution', () => {
  test.each(Object.values(CONTINUATION_MODES))(
    'resolves a unique %s prefix with its stamp',
    async mode => {
      const args = fixture();
      const resolved = await resolveRunContinuation({
        ...args,
        ...(mode === 'adopt' ? { adoptRunId: '12345678' } : { supersedesRunId: '12345678' }),
      });
      expect(resolved).toEqual({ run: args.run, stamp: { mode } });
      expect(args.store.findWorkflowRunsByIdPrefix).toHaveBeenCalledWith(
        '12345678',
        args.codebaseId
      );
      expect(args.store.getWorkflowRun).not.toHaveBeenCalled();
    }
  );

  test.each(workflowRunStatusSchema.options)(
    'checks target status %s for both modes',
    async status => {
      for (const mode of Object.values(CONTINUATION_MODES)) {
        const args = fixture();
        args.run.status = status;
        const result = resolveRunContinuation({
          ...args,
          ...(mode === 'adopt' ? { adoptRunId: fullId } : { supersedesRunId: fullId }),
        });
        if (TERMINAL_WORKFLOW_STATUSES.includes(status))
          expect(await result).toMatchObject({ run: { id: fullId } });
        else
          await expect(result).rejects.toThrow(
            `Cannot ${mode} run '${fullId}': it is still ${status}.`
          );
      }
    }
  );

  test('ordinary full IDs bypass project lookup and preserve cross-project supersede', async () => {
    const args = fixture();
    expect(
      await resolveRunContinuation({ ...args, codebaseId: 'other', supersedesRunId: fullId })
    ).toMatchObject({ run: args.run });
    expect(args.store.findWorkflowRunsByIdPrefix).not.toHaveBeenCalled();
    expect(args.store.getWorkflowRun).toHaveBeenCalledWith(fullId);
  });

  test('selected project never falls back to install-wide lookup', async () => {
    const args = fixture();
    await expect(
      resolveRunContinuation({
        ...args,
        codebaseId: 'other',
        restrictToProject: true,
        supersedesRunId: fullId,
      })
    ).rejects.toThrow('selected project');
    expect(args.store.getWorkflowRun).not.toHaveBeenCalled();
  });

  test('selected project requires exact normalized equality for full IDs', async () => {
    const args = fixture();
    args.store.findWorkflowRunsByIdPrefix.mockResolvedValue([makeRun({ id: fullId + 'extra' })]);
    await expect(
      resolveRunContinuation({ ...args, restrictToProject: true, supersedesRunId: fullId })
    ).rejects.toThrow('selected project');
  });

  test('undashed UUID query falls back to dashed project lookup', async () => {
    const args = fixture();
    const undashed = fullId.replaceAll('-', '');
    expect(
      await resolveRunContinuation({ ...args, restrictToProject: true, supersedesRunId: undashed })
    ).toMatchObject({ run: args.run });
    expect(args.store.findWorkflowRunsByIdPrefix.mock.calls).toEqual([
      [undashed, args.codebaseId],
      [fullId, args.codebaseId],
    ]);
  });

  test('unknown and ambiguous references retain the reference and candidates', async () => {
    const args = fixture();
    await expect(resolveRunContinuation({ ...args, supersedesRunId: 'unknown' })).rejects.toThrow(
      "'unknown'"
    );
    args.store.findWorkflowRunsByIdPrefix.mockResolvedValue([
      args.run,
      makeRun({ id: 'second-id' }),
    ]);
    await expect(resolveRunContinuation({ ...args, supersedesRunId: '123' })).rejects.toThrow(
      `${fullId}\n  second-id`
    );
  });

  test('prefix needs a project; full ID works without one', async () => {
    const args = fixture();
    await expect(
      resolveRunContinuation({ ...args, codebaseId: null, supersedesRunId: '123' })
    ).rejects.toThrow("prefix '123' without a selected project");
    expect(
      await resolveRunContinuation({ ...args, codebaseId: null, supersedesRunId: fullId })
    ).toMatchObject({ run: args.run });
  });

  test('no declaration does no I/O; paired declarations refuse', async () => {
    const args = fixture();
    expect(await resolveRunContinuation(args)).toBeUndefined();
    await expect(
      resolveRunContinuation({ ...args, adoptRunId: 'a', supersedesRunId: 'b' })
    ).rejects.toBeInstanceOf(WorkflowContinuationError);
    expect(args.store.getWorkflowRun).not.toHaveBeenCalled();
    expect(args.store.findWorkflowRunsByIdPrefix).not.toHaveBeenCalled();
  });

  test('backend failures retain their original evidence', async () => {
    const args = fixture();
    const failure = new Error('store unavailable');
    args.store.getWorkflowRun.mockRejectedValue(failure);
    await expect(resolveRunContinuation({ ...args, supersedesRunId: fullId })).rejects.toBe(
      failure
    );
  });
});
