import { expect, test } from 'bun:test';
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from './store';

const roots = trackTempRoots();

test.each([true, false])('legacy usage stays readable with snapshot=%s', async snapshot => {
  const root = roots(await mkdtemp(join(tmpdir(), 'usage-upgrade-')));
  const store = await createFileWorkflowStore({ root });
  const legacy = await store.createWorkflowRun({ workflow_name: 'legacy', user_message: '' });
  const independent = await store.createWorkflowRun({
    workflow_name: 'independent',
    user_message: '',
  });
  const dir = join(root, 'runs', legacy.id);
  const historical = {
    ...legacy,
    metadata: { total_cost_usd: 'free', total_tokens_in: 'unknown' },
  };
  const line = JSON.parse((await readFile(join(dir, 'log.jsonl'), 'utf8')).trim());
  await writeFile(join(dir, 'log.jsonl'), `${JSON.stringify({ ...line, run: historical })}\n`);
  if (snapshot) {
    await writeFile(join(dir, 'run.json'), JSON.stringify({ seq: line.seq, run: historical }));
  } else {
    await unlink(join(dir, 'run.json'));
  }

  const upgraded = await createFileWorkflowStore({ root });
  expect((await upgraded.getWorkflowRun(legacy.id))?.metadata).toEqual(historical.metadata);
  expect((await upgraded.getWorkflowRun(independent.id))?.id).toBe(independent.id);
  expect((await upgraded.listWorkflowRuns()).runs.map(run => run.id).sort()).toEqual(
    [legacy.id, independent.id].sort()
  );
  expect(await upgraded.findChildRuns(independent.id)).toEqual([]);
  expect(await upgraded.getRunAncestry(independent.id)).toEqual([]);
  expect(await upgraded.findResumableRun('missing', '/missing')).toBeNull();
  expect(await upgraded.findAdoptingRuns(independent.id)).toEqual([]);
  expect(await upgraded.findWorkflowRunsByIdPrefix(independent.id, 'other-codebase')).toEqual([]);
  expect(await upgraded.getActiveWorkflowRunByPath('/missing')).toBeNull();
  expect(await upgraded.listDueWorkflowContinuations(new Date(), 10)).toEqual([]);
  expect(await upgraded.findOpenWorkRuns()).toEqual([]);
  expect(await upgraded.listAttentionQueueRows()).toEqual([]);
});
