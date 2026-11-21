// @archon-test-isolated
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import { executeDagWorkflow } from '../dag-executor';
import { createFileWorkflowStore } from '../file-store/store';
import type { DagNode } from '../schemas';
import { restoreRunState } from './resume-state';
import {
  createMockDeps,
  createMockStore,
  dagOptions,
  makeWorkflowRun,
  mockSendQueryDag,
  persistedEvents,
} from './test-utils';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-trusted-sessions-'));
  mockSendQueryDag.mockClear();
});
afterEach(async () => {
  await removeTempTree(root);
});

const snapshot = {
  schemaVersion: 1,
  requirement: {
    subject: {
      kind: 'issue',
      ref: { repo: { host: 'github.com', path: 'owner/repo' }, number: 7 },
    },
    maintainersPath: '.archon/maintainers.json',
    input: 'trusted_item',
  },
  title: 'Accepted',
  body: 'Snapshot',
  contentDigest: 'a'.repeat(64),
  editProvenance: { editor: null, lastEditedAt: null, titleEditor: null, titleEditedAt: null },
  policy: { head: 'b'.repeat(40), digest: 'c'.repeat(64), maintainers: ['alice'] },
};

test.each([
  ['item context', { context: 'same' }, false],
  ['node persistence', { persist_session: true }, false],
  ['workflow persistence', {}, true],
] as const)(
  'protected %s never reads older scoped sessions but continues its own run',
  async (_name, nodeOptions, persistSessions) => {
    const files = await createFileWorkflowStore({ root: join(root, 'store') });
    const store = createMockStore();
    store.listWorkflowNodeSessions.mockImplementation(scope =>
      files.listWorkflowNodeSessions(scope)
    );
    store.upsertWorkflowNodeSession.mockImplementation(row => files.upsertWorkflowNodeSession(row));
    const deps = createMockDeps(store);
    deps.trustedText = {
      readEvidence: async () => {
        throw new Error('unexpected evidence read');
      },
      authorize: async () => {
        throw new Error('unexpected authorization');
      },
      recheck: async () => undefined,
    };
    const nodes: DagNode[] = [
      {
        id: 'reader',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'Read' },
        allowed_tools: ['Read'],
        ...nodeOptions,
      },
    ];
    async function run(id: string, protectedRun: boolean) {
      await executeDagWorkflow(
        dagOptions({
          deps,
          cwd: root,
          workflow: {
            name: 'session-trust',
            webSearchMode: 'disabled',
            persist_sessions: persistSessions,
            nodes,
          },
          workflowRun: makeWorkflowRun(id, {
            item_id: 'item-7',
            metadata: protectedRun ? { trusted_text: snapshot } : {},
          }),
        })
      );
    }
    await run('unprotected', false);
    expect(
      await files.listWorkflowNodeSessions({
        workflow_name: 'session-trust',
        scope_key:
          'context' in nodeOptions && nodeOptions.context === 'same' ? 'item:item-7' : 'conv-dag',
      })
    ).toMatchObject([{ provider_session_id: 'dag-session-id', last_run_id: 'unprotected' }]);
    store.listWorkflowNodeSessions.mockClear();
    store.upsertWorkflowNodeSession.mockClear();
    mockSendQueryDag.mockClear();
    await run('protected', true);
    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
    expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
    expect(store.listWorkflowNodeSessions).not.toHaveBeenCalled();
    expect(store.upsertWorkflowNodeSession).not.toHaveBeenCalled();
    const ownNode = { ...nodes[0]!, context: { resume: 'reader' } };
    const state = restoreRunState(
      store,
      dagOptions({
        deps,
        cwd: root,
        workflowRun: makeWorkflowRun('protected'),
        workflow: { name: 'session-trust', nodes: [ownNode] },
      }).workflow,
      makeWorkflowRun('protected', { metadata: { trusted_text: snapshot } }),
      new Map([['reader', { output: 'Accepted output' }]]),
      [
        {
          workflow_run_id: 'unprotected',
          node_id: 'reader',
          provider: 'claude',
          provider_session_id: 'unsafe-session',
          created_at: '',
          updated_at: '',
        },
        {
          workflow_run_id: 'protected',
          node_id: 'reader',
          provider: 'claude',
          provider_session_id: 'own-session',
          created_at: '',
          updated_at: '',
        },
        {
          workflow_run_id: 'unprotected',
          node_id: 'reader',
          provider: 'claude',
          provider_session_id: 'unsafe-session',
          created_at: '',
          updated_at: '',
        },
      ]
    );
    expect(state.nodeSessionHandles.get('reader')).toEqual({
      provider: 'claude',
      sessionId: 'own-session',
    });
  }
);

test("protected sequential agents still fork only this run's history", async () => {
  const deps = createMockDeps();
  deps.trustedText = {
    readEvidence: async () => {
      throw new Error('unexpected evidence read');
    },
    authorize: async () => {
      throw new Error('unexpected authorization');
    },
    recheck: mock(async () => undefined),
  };
  await executeDagWorkflow(
    dagOptions({
      deps,
      cwd: root,
      workflow: {
        name: 'same-run',
        webSearchMode: 'disabled',
        nodes: ['first', 'second'].map((id, index) => ({
          id,
          kind: 'agent',
          source: { kind: 'inline', prompt: id },
          allowed_tools: ['Read'],
          ...(index ? { depends_on: ['first'] } : {}),
        })),
      },
      workflowRun: makeWorkflowRun('protected', { metadata: { trusted_text: snapshot } }),
    })
  );
  expect(mockSendQueryDag).toHaveBeenCalledTimes(2);
  expect(mockSendQueryDag.mock.calls[0][2]).toBeUndefined();
  expect(mockSendQueryDag.mock.calls[1][2]).toBe('dag-session-id');
  expect(deps.trustedText.recheck).toHaveBeenCalledTimes(2);
});

test('a later agent rejects input drift even when the inherited snapshot still rechecks', async () => {
  const deps = createMockDeps();
  const run = makeWorkflowRun('protected', {
    metadata: {
      trusted_text: snapshot,
      inputs_values: { trusted_item: { title: snapshot.title, body: snapshot.body } },
    },
  });
  deps.trustedText = {
    readEvidence: async () => {
      throw new Error('unexpected evidence read');
    },
    authorize: async () => {
      throw new Error('unexpected authorization');
    },
    recheck: async () => undefined,
  };
  mockSendQueryDag.mockImplementationOnce(async function* () {
    run.metadata.inputs_values = { trusted_item: { title: 'Caller', body: 'Unaccepted' } };
    yield { type: 'result', sessionId: 'accepted-session' };
  });
  await executeDagWorkflow(
    dagOptions({
      deps,
      cwd: root,
      workflowRun: run,
      workflow: {
        name: 'input-drift',
        webSearchMode: 'disabled',
        nodes: ['first', 'second'].map((id, index) => ({
          id,
          kind: 'agent',
          source: { kind: 'inline', prompt: 'Read' },
          allowed_tools: ['Read'],
          ...(index ? { depends_on: ['first'] } : {}),
        })),
      },
    })
  );
  expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(persistedEvents(deps.store))).toContain('trusted_text_input_mismatch');
});
