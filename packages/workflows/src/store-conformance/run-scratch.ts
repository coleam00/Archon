import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import {
  getArchonWorkspacesPath,
  getRunArtifactsDirForRoot,
  getRunScratchDir,
} from '@archon/paths/archon-paths';
import { removeTempTree } from '@archon/paths/test-utils';
import type { IWorkflowStore } from '../store';
import type { ApprovalContext, WorkflowRunStatus } from '../schemas';

const evidence = {
  'report.md': '# report\n',
  'evidence/red.log': 'failing output\n',
  '.archon/typed-artifacts/listing.json': '{}\n',
};
const bulk = ['bisect/.git/HEAD', 'bisect/node_modules/pkg/index.js'];

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Every path segment under `dir`, so a checkout or install at any depth is seen. */
function segments(dir: string): Set<string> {
  return new Set(
    readdirSync(dir, { recursive: true, encoding: 'utf8' }).flatMap(p => p.split(sep))
  );
}

export function describeRunScratchConformance(
  getStore: () => IWorkflowStore,
  conversationId: string
): void {
  describe('terminal scratch release', () => {
    const approval: ApprovalContext = {
      nodeId: 'review',
      message: 'Choose',
      type: 'approval',
      pauseId: 'scratch',
    };

    async function runWithScratch(): Promise<{ id: string; root: string; artifactsDir: string }> {
      const store = getStore();
      const created = await store.createWorkflowRun({
        workflow_name: 'scratch',
        user_message: '',
        origin: { conversationId },
      });
      const run = await store.claimPendingWorkflowRun(created.id);
      if (!run) throw new Error('run was not claimed');
      const root = join(getArchonWorkspacesPath(), '_cwd', `scratch-${run.id}`);
      await store.updateWorkflowRun(run.id, { output_root: root });
      const artifactsDir = getRunArtifactsDirForRoot(root, run.id);
      for (const [path, content] of Object.entries(evidence))
        write(join(artifactsDir, path), content);
      for (const path of bulk) write(join(getRunScratchDir(artifactsDir), path), 'x');
      return { id: run.id, root, artifactsDir };
    }

    type Transition = (store: IWorkflowStore, id: string) => Promise<unknown>;
    const fromRunning = [
      ['completed', (store, id) => store.completeWorkflowRun(id, { duration_ms: 1 })],
      ['failed', (store, id) => store.failWorkflowRun(id, 'failure')],
      ['cancelled', (store, id) => store.cancelWorkflowRun(id)],
    ] as const satisfies readonly (readonly [WorkflowRunStatus, Transition])[];
    // Each SQL writer that ends a paused run releases scratch on its own commit path.
    const fromPaused = [
      ['an abandon', (store, id) => store.cancelWorkflowRun(id)],
      [
        'a rejected approval',
        (store, id) => store.resolveAndCancelApprovalGate(id, [], { reason: 'rejected' }),
      ],
      ['a conversation reset', store => store.cancelResumableRunsForConversation(conversationId)],
      ['a fan-out cancel', (store, id) => store.cancelFanOutRun(id, 'fan_out_sibling')],
    ] as const satisfies readonly (readonly [string, Transition])[];

    async function expectScratchReleased(
      paused: boolean,
      transition: Transition,
      status: WorkflowRunStatus
    ): Promise<void> {
      const { id, root, artifactsDir } = await runWithScratch();
      try {
        if (paused) await getStore().pauseWorkflowRun(id, approval);
        await transition(getStore(), id);
        expect((await getStore().getWorkflowRun(id))?.status).toBe(status);
        const names = segments(artifactsDir);
        expect(names.has('node_modules')).toBe(false);
        expect(names.has('.git')).toBe(false);
        for (const [path, content] of Object.entries(evidence))
          expect(readFileSync(join(artifactsDir, path), 'utf8')).toBe(content);
      } finally {
        await removeTempTree(root);
      }
    }

    for (const [status, transition] of fromRunning) {
      test(`a run that becomes ${status} keeps its evidence and loses its scratch checkout`, () =>
        expectScratchReleased(false, transition, status));
    }
    for (const [path, transition] of fromPaused) {
      test(`a paused run cancelled by ${path} keeps its evidence and loses its scratch checkout`, () =>
        expectScratchReleased(true, transition, 'cancelled'));
    }

    test('a paused run keeps its scratch', async () => {
      const { id, root, artifactsDir } = await runWithScratch();
      try {
        await getStore().pauseWorkflowRun(id, approval);
        expect(segments(artifactsDir).has('node_modules')).toBe(true);
      } finally {
        await removeTempTree(root);
      }
    });
  });
}
