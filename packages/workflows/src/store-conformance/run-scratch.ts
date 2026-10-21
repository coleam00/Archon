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
    // A running run's nodes may still write after these commit; its executor removes
    // scratch once they stop.
    const fromRunning = [
      ['completed', 'completed', (store, id) => store.completeWorkflowRun(id, { duration_ms: 1 })],
      ['failed', 'failed', (store, id) => store.failWorkflowRun(id, 'failure')],
      ['cancelled', 'cancelled', (store, id) => store.cancelWorkflowRun(id)],
      [
        'cancelled by its fan-out',
        'cancelled',
        (store, id) => store.cancelFanOutRun(id, 'fan_out_sibling'),
      ],
    ] as const satisfies readonly (readonly [string, WorkflowRunStatus, Transition])[];
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

    async function afterTransition(
      paused: boolean,
      transition: Transition,
      status: WorkflowRunStatus
    ): Promise<{ released: boolean }> {
      const { id, root, artifactsDir } = await runWithScratch();
      try {
        if (paused) await getStore().pauseWorkflowRun(id, approval);
        await transition(getStore(), id);
        expect((await getStore().getWorkflowRun(id))?.status).toBe(status);
        for (const [path, content] of Object.entries(evidence))
          expect(readFileSync(join(artifactsDir, path), 'utf8')).toBe(content);
        const names = segments(artifactsDir);
        expect(names.has('.git')).toBe(names.has('node_modules'));
        return { released: !names.has('node_modules') };
      } finally {
        await removeTempTree(root);
      }
    }

    for (const [ending, status, transition] of fromRunning) {
      test(`a running run that becomes ${ending} keeps its scratch for its executor`, async () => {
        expect(await afterTransition(false, transition, status)).toEqual({ released: false });
      });
    }
    for (const [path, transition] of fromPaused) {
      test.skipIf(process.platform === 'win32')(
        `a paused run cancelled by ${path} keeps its evidence and loses its scratch checkout`,
        async () => {
          expect(await afterTransition(true, transition, 'cancelled')).toEqual({ released: true });
        }
      );
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
