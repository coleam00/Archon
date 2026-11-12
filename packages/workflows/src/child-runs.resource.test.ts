// @archon-test-isolated
import { makeDeps, makePlatform, makeFakeResolver } from './child-runs/test-utils';
import { test, expect, spyOn } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createFileWorkflowStore } from './file-store/store';
import { makeTestResolvedWorkflow } from './test-utils';
import { runChildWorkflow } from './child-runs';
import { admitNativeResourceStart } from './resource-start-admission';

const track = trackTempRoots();
test.each(['inherit', 'worktree', 'placement-fails', 'notice-fails'] as const)(
  'resource child admission preserves ownership: %s',
  async scenario => {
    const isolation = scenario === 'inherit' ? 'inherit' : 'worktree';
    const root = track(await mkdtemp(join(tmpdir(), 'resource-child-')));
    const previousHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = join(root, 'home');
    try {
      await mkdir(join(root, '.archon/workflows'), { recursive: true });
      await writeFile(
        join(root, '.archon/workflows/child.yaml'),
        'name: child\ndescription: child\nresource: { name: build, capacity: 1 }\nnodes:\n  - id: done\n    bash: echo complete\n'
      );
      const store = await createFileWorkflowStore({ root: join(root, 'store') });
      const holder = await store.createWorkflowRun({
        id: crypto.randomUUID(),
        workflow_name: 'holder',
        codebase_id: 'project',
        user_message: '',
      });
      await admitNativeResourceStart(
        store,
        makeTestResolvedWorkflow({
          name: 'holder',
          description: 'Hold the resource',
          nodes: [],
          resource: { name: 'build', capacity: 1 },
        }),
        holder,
        {
          cwd: join(root, 'other'),
          conversationId: 'conversation',
          isolation: { kind: 'worktree' },
        }
      );
      const parent = await store.createWorkflowRun({
        workflow_name: 'parent',
        codebase_id: 'project',
        user_message: 'parent',
      });
      const { resolver, calls } = makeFakeResolver(join(root, 'child-checkout'));
      if (scenario === 'placement-fails')
        resolver.resolve = async () => {
          throw new Error('checkout failed');
        };
      const platform = makePlatform();
      let queuedId: string | undefined;
      const send = spyOn(platform, 'sendMessage').mockImplementation(
        async (_conversation, message) => {
          if (!message.startsWith('Waiting for resource')) return;
          const children = await store.findChildRuns(parent.id);
          queuedId = children[0]?.id;
          expect(queuedId).toBeDefined();
          expect(children[0]?.working_path).toBeNull();
          expect(calls).toHaveLength(0);
          expect((await store.getResourceStartRequest(queuedId!))?.status).toBe('queued');
          if (scenario === 'notice-fails') throw new Error('notification unavailable');
          await store.cancelWorkflowRun(holder.id);
        }
      );
      const outcome = await runChildWorkflow(
        makeDeps(store),
        platform,
        {
          parentRun: parent,
          nodeId: 'spawn',
          childWorkflowName: 'child',
          input: 'payload',
          cwd: root,
          conversationId: 'conversation',
          codebaseId: 'project',
          isolation,
        },
        {},
        undefined,
        'dev',
        resolver
      );
      expect(outcome.status).toBe(scenario.endsWith('fails') ? 'failed' : 'completed');
      expect(queuedId).toBe(outcome.childRunId);
      const run = await store.getWorkflowRun(outcome.childRunId);
      expect(run?.parent_run_id).toBe(parent.id);
      expect(run?.metadata.parent_node_id).toBe('spawn');
      expect(run?.user_message).toBe('payload');
      expect((await store.getResourceStartRequest(outcome.childRunId))?.declaredCapacity).toBe(1);
      expect(calls).toHaveLength(scenario === 'worktree' ? 1 : 0);
      if (scenario === 'notice-fails') {
        expect(run?.status).toBe('pending');
        expect((await store.getResourceStartRequest(outcome.childRunId))?.status).toBe('queued');
        const source = run?.metadata.workflow_source;
        if (
          !source ||
          typeof source !== 'object' ||
          !('root' in source) ||
          typeof source.root !== 'string'
        )
          throw new Error('Queued source must remain recorded');
        expect(existsSync(source.root)).toBe(true);
        expect((await store.getWorkflowRun(holder.id))?.status).toBe('pending');
      }
      if (scenario === 'placement-fails') {
        expect(run?.status).toBe('failed');
        expect(run?.working_path).toBeNull();
      }
      expect(send).toHaveBeenCalled();
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
    }
  }
);
