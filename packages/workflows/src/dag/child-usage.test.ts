import { expect, it } from 'bun:test';
import { foldDagResumeSnapshot } from '../dag-resume-snapshot';
import { finishNodeExecution, newNodeInvocation, startNodeExecution } from '../node-execution';
import { serializeNodeStateRecord } from '../node-record-serialization';
import { unreportedChildUsage } from './child-usage';
import { sumReportedCost, sumFanOutTokens } from './usage';

it('subtracts each retained child baseline while charging a replacement in full', async () => {
  const first = { childRunId: 'retained', costUsd: 0.01, tokens: { input: 7, output: 3 } };
  const deleted = { ...first, childRunId: 'deleted' };
  const later = { ...first, costUsd: 0.02, tokens: { input: 14, output: 6 } };
  const terminal = (children: (typeof first)[], costUsd: number) =>
    serializeNodeStateRecord(
      finishNodeExecution(
        startNodeExecution({
          runId: 'parent',
          path: 'sub',
          node: { id: 'sub', kind: 'workflow', workflow: 'child' },
          invocation: newNodeInvocation(),
        }),
        { status: 'failed', error: 'child failed' },
        {
          costUsd,
          diagnostics: { childUsage: children },
        }
      )
    );
  const snapshot = await foldDagResumeSnapshot(
    [terminal([first, deleted], 0.02), terminal([later, deleted], 0.01)],
    'parent'
  );
  expect(snapshot.costUsd).toBe(0.03);
  expect(snapshot.reportedChildUsage?.get('retained')).toEqual(later);
  const contributions = [later, { ...first, childRunId: 'replacement' }].map(child =>
    unreportedChildUsage(child, snapshot.reportedChildUsage, child.childRunId)
  );
  expect(sumReportedCost(contributions)).toBe(0.01);
  expect(sumFanOutTokens(contributions)).toEqual({ input: 7, output: 3 });
  expect(unreportedChildUsage(first, undefined, first.childRunId)).toBe(first);
});
