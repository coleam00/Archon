// @archon-test-isolated
import type { ArtifactExchange } from '../container-context';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { executeDagWorkflow } from '../dag-executor';
import * as dispatch from './dispatch';
import { TerminalStatusWriteError } from '../terminal-status-write';
import { NodeEventWriteError } from '../node-event-write';
import { RunBudgetRefusedError } from '../run-budget';
import { RunSourceUnreadableError } from './node-source';
import { NodeFailure } from './ai-turn';
import { readNodeRecordEvent } from '../node-record-reader';
import { writeNodeArtifact } from '../artifacts-index';
import { dagNodeSchema } from '../schemas';
import {
  mockLogFn,
  runUsageWrites,
  createMockDeps,
  createMockStore,
  dagOptions,
  makeWorkflowRun,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  mockClaudeCapabilities,
  setMockArtifactHome,
  spyOnNodeExec,
} from './test-utils';

const format = {
  type: 'object',
  properties: {
    report: {
      type: 'object',
      properties: {
        type: { const: 'archon_artifact' },
        run_id: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['type', 'run_id', 'path'],
    },
  },
  required: ['report'],
};

function exchangeOptions({
  artifactExchange,
  ...options
}: Parameters<typeof dagOptions>[0] & { artifactExchange: ArtifactExchange }) {
  return dagOptions({
    ...options,
    containerCtx: {
      envId: 'exchange-env',
      writeBack: 'auto',
      artifactExchange,
      backend: {
        async suspend() {},
        async finalize() {
          return { requiresApproval: false };
        },
        async applyChanges() {
          return { filesApplied: 0, filesDeleted: 0, warnings: [] };
        },
        async discardChanges() {},
      },
    },
  });
}

describe('artifact exchange at workflow invocation boundaries', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dag-exchange-'));
    setMockArtifactHome(root);
    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });
  afterEach(async () => {
    setMockArtifactHome('/nonexistent/home');
    await removeTempTree(root);
  });

  it.each(['agent', 'bash', 'script'] as const)(
    'collects a %s pointer before certification and persists only after collection',
    async kind => {
      const store = createMockStore();
      const artifactsDir = join(root, 'artifacts', 'runs', 'pointer');
      const pointer = {
        report: { type: 'archon_artifact', run_id: 'pointer', path: 'report.bin' },
      };
      const events: string[] = [];
      let pending = false;
      const invoke = () => {
        expect(events).toEqual(['publish']);
        expect(existsSync(join(artifactsDir, 'report.bin'))).toBe(false);
        events.push('invoke');
        pending = true;
      };
      mockSendQueryDag.mockImplementation(async function* () {
        invoke();
        yield { type: 'result', structuredOutput: pointer };
      });
      const exec = spyOnNodeExec().mockImplementation(async () => {
        invoke();
        return { stdout: JSON.stringify(pointer), stderr: '' };
      });
      try {
        await executeDagWorkflow(
          exchangeOptions({
            deps: createMockDeps(store),
            cwd: root,
            artifactsDir,
            workflowRun: makeWorkflowRun('pointer', { output_root: root }),
            artifactExchange: {
              async publish() {
                events.push('publish');
              },
              async collect() {
                expect(pending).toBe(true);
                expect(store.completeWorkflowRun).not.toHaveBeenCalled();
                events.push('collect');
                await mkdir(artifactsDir, { recursive: true });
                await writeFile(join(artifactsDir, 'report.bin'), new Uint8Array([0, 255, 1]));
              },
            },
            workflow: {
              name: 'pointer',
              nodes: [
                dagNodeSchema.parse({
                  id: 'produce',
                  output_format: format,
                  ...(kind === 'agent'
                    ? { prompt: 'produce a report' }
                    : kind === 'bash'
                      ? { bash: 'echo report' }
                      : { runtime: 'bun', script: 'console.log("report")' }),
                }),
              ],
            },
          })
        );
        expect(events).toEqual(['publish', 'invoke', 'collect']);
        expect(store.completeWorkflowRun).toHaveBeenCalled();
        expect(
          store.createWorkflowEvent.mock.calls.some(
            ([e]) => e.event_type === 'node_completed' && e.data?.structured_output !== undefined
          )
        ).toBe(true);
      } finally {
        exec.mockRestore();
      }
    }
  );

  it.each([0, 1])(
    'preserves paid sibling usage and logs a typed-artifact refusal at index %s',
    async failingIndex => {
      mockLogFn.mockClear();
      const store = createMockStore();
      const artifactsDir = join(root, 'canonical');
      const outside = join(root, 'outside');
      await mkdir(artifactsDir);
      await mkdir(outside);
      await writeFile(join(outside, 'produce.md'), 'untouched');
      await symlink(outside, join(artifactsDir, 'nodes'));
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'output' };
        yield { type: 'result', cost: 0.1, tokens: { input: 10, output: 1 } };
      });
      await expect(
        executeDagWorkflow(
          exchangeOptions({
            deps: createMockDeps(store),
            cwd: root,
            artifactsDir,
            workflowRun: makeWorkflowRun('typed-refusal', { output_root: root }),
            artifactExchange: { async publish() {}, async collect() {} },
            workflow: {
              name: 'typed-refusal',
              description: 'test',
              nodes: [0, 1].map(index =>
                dagNodeSchema.parse({
                  id: index === failingIndex ? 'produce' : 'sibling',
                  prompt: 'produce',
                  ...(index === failingIndex ? { output_type: 'text' } : {}),
                })
              ),
            },
          })
        )
      ).rejects.toThrow('real directory');
      expect(await readFile(join(outside, 'produce.md'), 'utf8')).toBe('untouched');
      expect(store.completeWorkflowRun).not.toHaveBeenCalled();
      expect(runUsageWrites(store).at(-1)).toMatchObject({
        total_cost_usd: 0.2,
        total_tokens_in: 20,
        total_tokens_out: 2,
      });
      expect(mockLogFn.mock.calls).toContainEqual([
        expect.objectContaining({
          nodeId: 'produce',
          workflowRunId: 'typed-refusal',
          err: expect.objectContaining({ message: expect.stringContaining('real directory') }),
        }),
        'artifacts.write_failed',
      ]);
    }
  );

  it.each([
    new TerminalStatusWriteError(new Error('terminal unavailable')),
    new NodeEventWriteError(
      { workflow_run_id: 'mixed', step_name: 'recovery', event_type: 'node_started', data: {} },
      new Error('events unavailable')
    ),
    new RunBudgetRefusedError({
      reason: 'work_units_exhausted',
      path: 'recovery',
      limit: 1,
      consumed: 1,
    }),
    new RunSourceUnreadableError('recovery', new Error('source unavailable')),
  ])(
    'preserves mixed-layer recovery rejection %s alongside artifact refusal',
    async recoveryError => {
      mockLogFn.mockClear();
      const artifactsDir = join(root, 'canonical');
      const outside = join(root, 'outside');
      await mkdir(artifactsDir);
      await mkdir(outside);
      await symlink(outside, join(artifactsDir, 'nodes'));
      const store = createMockStore();
      const originalDispatch = dispatch.dispatchNode;
      const dispatchSpy = spyOn(dispatch, 'dispatchNode').mockImplementation(
        async (ctx, node, parallel) => {
          if (node.id === 'recovery') throw recoveryError;
          return originalDispatch(ctx, node, parallel);
        }
      );
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'paid work' };
        yield { type: 'result', cost: 0.1, tokens: { input: 10, output: 1 } };
      });
      try {
        const execution = executeDagWorkflow(
          exchangeOptions({
            deps: createMockDeps(store),
            cwd: root,
            artifactsDir,
            workflowRun: makeWorkflowRun('mixed', { output_root: root }),
            artifactExchange: { async publish() {}, async collect() {} },
            workflow: {
              name: 'mixed',
              nodes: [
                dagNodeSchema.parse({ id: 'produce', prompt: 'work', output_type: 'text' }),
                dagNodeSchema.parse({ id: 'recovery', prompt: 'work' }),
              ],
            },
          })
        );
        if (recoveryError instanceof RunSourceUnreadableError) {
          await execution;
          expect(store.releaseRunForUnreadableSource).toHaveBeenCalled();
        } else await expect(execution).rejects.toBe(recoveryError);
        expect(mockLogFn.mock.calls).toContainEqual([
          expect.objectContaining({
            nodeId: 'produce',
            err: expect.objectContaining({ message: expect.stringContaining('real directory') }),
          }),
          'artifacts.write_failed',
        ]);
        expect(await readdir(outside)).toEqual([]);
        expect(store.completeWorkflowRun).not.toHaveBeenCalled();
      } finally {
        dispatchSpy.mockRestore();
      }
    }
  );

  it.each(['loop-group', 'compose', 'compose-all-done', 'compose-loop-group'] as const)(
    'preserves paid nested %s usage and closes its failure record',
    async kind => {
      const artifactsDir = join(root, 'canonical');
      await mkdir(join(root, '.archon', 'workflows'), { recursive: true });
      await writeFile(
        join(root, '.archon', 'workflows', 'block.yaml'),
        kind === 'compose-loop-group'
          ? 'name: block\ndescription: Nested usage\nnodes:\n  - id: group\n    loop_group:\n      max_iterations: 1\n      until: DONE\n      nodes:\n        - id: work\n          prompt: work\n          output_type: text\n'
          : 'name: block\ndescription: Nested usage\nnodes:\n  - id: work\n    prompt: work\n    output_type: text\n'
      );
      const store = createMockStore();
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'paid work' };
        yield { type: 'result', cost: 0.1, tokens: { input: 10, output: 1 } };
      });
      await executeDagWorkflow(
        exchangeOptions({
          deps: createMockDeps(store),
          cwd: root,
          artifactsDir,
          workflowRun: makeWorkflowRun('nested-failure', { output_root: root }),
          artifactExchange: {
            async publish() {},
            async collect() {
              await writeFile(join(artifactsDir, 'nodes'), 'blocks sidecar directory');
            },
          },
          workflow: {
            name: 'nested-failure',
            nodes: [
              dagNodeSchema.parse(
                kind !== 'loop-group'
                  ? {
                      id: 'outer',
                      include: 'block',
                      fan_out: {
                        items: '[1]',
                        as: 'item',
                        max_parallel: 1,
                        join: kind === 'compose' ? 'all_success' : 'all_done',
                      },
                    }
                  : {
                      id: 'outer',
                      loop_group: {
                        max_iterations: 1,
                        until: 'DONE',
                        nodes: [{ id: 'work', prompt: 'work', output_type: 'text' }],
                      },
                    }
              ),
            ],
          },
        })
      );
      expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
      expect(runUsageWrites(store).at(-1)).toMatchObject({
        total_cost_usd: 0.1,
        total_tokens_in: 10,
        total_tokens_out: 1,
      });
      const records = store.createWorkflowEvent.mock.calls.flatMap(([event]) => {
        const record = readNodeRecordEvent({ ...event, data: event.data });
        return record ? [record] : [];
      });
      const started = records.filter(record => record.metadata?.lifecycle.status === 'started');
      expect(started.length).toBeGreaterThan(0);
      for (const record of started) {
        expect(
          records.some(
            terminal =>
              terminal.metadata?.invocation.id === record.metadata?.invocation.id &&
              (terminal.metadata?.lifecycle.status === 'completed' ||
                terminal.metadata?.lifecycle.status === 'failed')
          )
        ).toBe(true);
      }
      const failedOwner = records.find(
        record =>
          record.metadata?.node.kind ===
            (kind !== 'loop-group' ? 'compose_fan_out_instance' : 'loop_group') &&
          record.metadata.lifecycle.status === 'failed'
      );
      expect(failedOwner?.metadata?.spend).toMatchObject({
        costUsd: { source: 'provider', value: 0.1 },
        tokens: { source: 'provider', value: { input: 10, output: 1 } },
      });
      expect(store.completeWorkflowRun).not.toHaveBeenCalled();
    }
  );

  it.each([
    'agent-listing',
    'bash-listing',
    'script-listing',
    'loop-listing',
    'loop-group-listing',
    'bash-persisted',
    'script-persisted',
    'bash-reference',
    'nested-sidecar',
  ] as const)('fails composed all_done after required %s refusal', async kind => {
    mockLogFn.mockClear();
    const artifactsDir = join(root, 'canonical');
    const outside = join(root, 'outside');
    await mkdir(artifactsDir);
    await mkdir(outside);
    await writeFile(join(outside, 'sentinel'), 'untouched');
    const workflows = join(root, '.archon', 'workflows');
    await mkdir(workflows, { recursive: true });
    const large = 'x'.repeat(40_000);
    const body =
      kind === 'agent-listing' || kind === 'nested-sidecar'
        ? 'prompt: work\n    output_type: text'
        : kind === 'loop-listing'
          ? 'loop: {prompt: work, until: DONE, max_iterations: 1}'
          : kind === 'loop-group-listing'
            ? 'loop_group: {until: DONE, max_iterations: 1, nodes: [{id: child, prompt: work}]}'
            : kind.startsWith('script')
              ? 'runtime: bun\n    script: console.log("work")'
              : kind === 'bash-reference'
                ? 'bash: echo $seed.output'
                : 'bash: echo work';
    await writeFile(
      join(workflows, 'block.yaml'),
      `name: block\ndescription: Required write failure\nnodes:\n  - id: work\n    ${body}\n`
    );
    if (kind === 'nested-sidecar') {
      await writeFile(
        join(workflows, 'nested.yaml'),
        'name: nested\ndescription: Nested join\nnodes:\n  - id: inner\n    include: block\n    fan_out: {items: "[1]", as: item, max_parallel: 1, join: all_done}\n'
      );
      await symlink(outside, join(artifactsDir, 'nodes'));
    } else {
      await mkdir(join(artifactsDir, '.archon'));
      await symlink(
        outside,
        join(
          artifactsDir,
          '.archon',
          kind.endsWith('listing') ? 'typed-artifacts' : 'node-output-spills'
        )
      );
    }
    if (kind === 'bash-reference') {
      await writeFile(
        join(workflows, 'block.yaml'),
        `name: block\ndescription: Reference spill\nnodes:\n  - id: seed\n    prompt: seed\n  - id: work\n    depends_on: [seed]\n    ${body}\n`
      );
    }
    const store = createMockStore();
    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: kind === 'bash-reference' ? large : 'work' };
      yield { type: 'result' };
    });
    const exec = spyOnNodeExec().mockResolvedValue({ stdout: large, stderr: '' });
    try {
      await executeDagWorkflow(
        exchangeOptions({
          deps: createMockDeps(store),
          cwd: root,
          artifactsDir,
          workflowRun: makeWorkflowRun('required-write', { output_root: root }),
          artifactExchange: { async publish() {}, async collect() {} },
          workflow: {
            name: 'required-write',
            nodes: [
              dagNodeSchema.parse({
                id: 'outer',
                include: kind === 'nested-sidecar' ? 'nested' : 'block',
                fan_out: { items: '[1]', as: 'item', max_parallel: 1, join: 'all_done' },
              }),
            ],
          },
        })
      );
      expect(store.completeWorkflowRun).not.toHaveBeenCalled();
      expect(store.failWorkflowRun).toHaveBeenCalled();
      expect(store.createWorkflowEvent.mock.calls).toContainEqual([
        expect.objectContaining({ event_type: 'node_failed', step_name: 'outer' }),
      ]);
      expect(mockLogFn.mock.calls).toContainEqual([
        expect.objectContaining({
          err: expect.objectContaining({ message: expect.stringContaining('real directory') }),
        }),
        'artifacts.write_failed',
      ]);
      expect(mockSendQueryDag).toHaveBeenCalledTimes(
        kind === 'nested-sidecar' || kind === 'bash-reference' ? 1 : 0
      );
      expect(exec).toHaveBeenCalledTimes(kind.endsWith('persisted') ? 1 : 0);
      if (kind.endsWith('persisted') || kind === 'bash-reference') {
        expect(mockLogFn.mock.calls).toContainEqual([
          expect.objectContaining({
            dir: kind.endsWith('persisted')
              ? join(artifactsDir, '.archon', 'node-output-spills', 'persisted')
              : join(artifactsDir, '.archon', 'node-output-spills'),
          }),
          'dag.spill_file_write_failed',
        ]);
      }
      expect(await readdir(outside)).toEqual(['sentinel']);
      expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('untouched');
    } finally {
      exec.mockRestore();
    }
  });

  for (const joinRule of ['all_success', 'all_done'] as const) {
    it.each(['collision', 'linked-parent', 'io'] as const)(
      `fails composed ${joinRule} after a required %s sidecar failure`,
      async failure => {
        mockLogFn.mockClear();
        const artifactsDir = join(root, 'canonical');
        const outside = join(root, 'outside');
        await mkdir(outside);
        await mkdir(join(root, '.archon', 'workflows'), { recursive: true });
        await writeFile(
          join(root, '.archon', 'workflows', 'block.yaml'),
          'name: block\ndescription: Artifact failure\nnodes:\n  - id: work\n    prompt: work\n    output_type: text\n'
        );
        const store = createMockStore();
        mockSendQueryDag.mockImplementation(async function* () {
          yield { type: 'agent_message_chunk', text: 'paid work' };
          yield { type: 'result', cost: 0.1, tokens: { input: 10, output: 1 } };
        });
        await executeDagWorkflow(
          exchangeOptions({
            deps: createMockDeps(store),
            cwd: root,
            artifactsDir,
            workflowRun: makeWorkflowRun('compose-sidecar', { output_root: root }),
            artifactExchange: {
              async publish() {},
              async collect() {
                const record = store.createWorkflowEvent.mock.calls
                  .map(([event]) => readNodeRecordEvent({ ...event, data: event.data }))
                  .find(record => record?.metadata?.node.kind === 'agent');
                const nodeId = record?.metadata?.node.id;
                expect(nodeId).toBeDefined();
                if (!nodeId) throw new Error('missing started body');
                if (failure === 'collision') {
                  await writeNodeArtifact(
                    artifactsDir,
                    {
                      nodeId: nodeId.replace('_', '.'),
                      outputType: 'text',
                      runId: 'compose-sidecar',
                      producedAt: new Date().toISOString(),
                    },
                    'original owner'
                  );
                } else if (failure === 'linked-parent')
                  await symlink(outside, join(artifactsDir, 'nodes'));
                else await mkdir(join(artifactsDir, 'nodes', `${nodeId}.md`), { recursive: true });
              },
            },
            workflow: {
              name: 'compose-sidecar',
              nodes: [
                dagNodeSchema.parse({
                  id: 'outer',
                  include: 'block',
                  fan_out: { items: '[1]', as: 'item', max_parallel: 1, join: joinRule },
                }),
              ],
            },
          })
        );
        expect(store.completeWorkflowRun).not.toHaveBeenCalled();
        expect(store.failWorkflowRun).toHaveBeenCalled();
        expect(store.createWorkflowEvent.mock.calls).toContainEqual([
          expect.objectContaining({ event_type: 'node_failed', step_name: 'outer' }),
        ]);
        expect(mockLogFn.mock.calls).toContainEqual([
          expect.objectContaining({ workflowRunId: 'compose-sidecar' }),
          'artifacts.write_failed',
        ]);
        expect(runUsageWrites(store).at(-1)).toMatchObject({
          total_cost_usd: 0.1,
          total_tokens_in: 10,
          total_tokens_out: 1,
        });
        expect(await readdir(outside)).toEqual([]);
      }
    );

    for (const kind of ['agent', 'bash', 'script'] as const) {
      it.each(['publish', 'collect'] as const)(
        `fails composed ${joinRule} after required %s for a ${kind} body`,
        async operation => {
          await mkdir(join(root, '.archon', 'workflows'), { recursive: true });
          const body =
            kind === 'agent'
              ? 'prompt: work'
              : kind === 'bash'
                ? 'bash: echo work'
                : 'runtime: bun\n    script: console.log("work")';
          await writeFile(
            join(root, '.archon', 'workflows', 'block.yaml'),
            `name: block\ndescription: Exchange failure\nnodes:\n  - id: work\n    ${body}\n`
          );
          const store = createMockStore();
          mockSendQueryDag.mockImplementation(async function* () {
            yield { type: 'agent_message_chunk', text: 'work' };
            yield { type: 'result' };
          });
          const exec = spyOnNodeExec().mockResolvedValue({ stdout: 'work', stderr: '' });
          const refused = new Error('exchange refused');
          try {
            await executeDagWorkflow(
              exchangeOptions({
                deps: createMockDeps(store),
                cwd: root,
                workflowRun: makeWorkflowRun('compose-exchange', { output_root: root }),
                artifactExchange: {
                  async publish() {
                    if (operation === 'publish') throw refused;
                  },
                  async collect() {
                    if (operation === 'collect') throw refused;
                  },
                },
                workflow: {
                  name: 'compose-exchange',
                  nodes: [
                    dagNodeSchema.parse({
                      id: 'outer',
                      include: 'block',
                      fan_out: { items: '[1]', as: 'item', max_parallel: 1, join: joinRule },
                    }),
                  ],
                },
              })
            );
            expect(store.completeWorkflowRun).not.toHaveBeenCalled();
            expect(store.failWorkflowRun).toHaveBeenCalled();
            expect(store.createWorkflowEvent.mock.calls).toContainEqual([
              expect.objectContaining({ event_type: 'node_failed', step_name: 'outer' }),
            ]);
          } finally {
            exec.mockRestore();
          }
        }
      );
    }
  }

  it.each(['collision', 'linked-parent', 'io'] as const)(
    'persists later settled sibling artifacts after a %s refusal',
    async failure => {
      mockLogFn.mockClear();
      const artifactsDir = join(root, 'canonical');
      const store = createMockStore();
      let collections = 0;
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'paid work' };
        yield { type: 'result', cost: 0.1, tokens: { input: 10, output: 1 } };
      });
      await expect(
        executeDagWorkflow(
          exchangeOptions({
            deps: createMockDeps(store),
            cwd: root,
            artifactsDir,
            workflowRun: makeWorkflowRun('siblings', { output_root: root }),
            artifactExchange: {
              async publish() {},
              async collect() {
                if (++collections !== 3 || failure === 'collision') return;
                if (failure === 'io')
                  await mkdir(join(artifactsDir, 'nodes', 'a_b.md'), { recursive: true });
                else {
                  const outside = join(root, 'outside');
                  await mkdir(outside);
                  await symlink(outside, join(artifactsDir, 'nodes'));
                }
              },
            },
            workflow: {
              name: 'siblings',
              nodes: ['a.b', 'a_b', 'later'].map(id =>
                dagNodeSchema.parse({ id, prompt: 'work', output_type: 'text' })
              ),
            },
          })
        )
      ).rejects.toThrow();
      if (failure === 'linked-parent') {
        expect(await readdir(join(root, 'outside'))).toEqual([]);
        for (const nodeId of ['a.b', 'a_b', 'later']) {
          expect(mockLogFn.mock.calls).toContainEqual([
            expect.objectContaining({ nodeId }),
            'artifacts.write_failed',
          ]);
        }
      } else {
        expect(await readFile(join(artifactsDir, 'nodes', 'later.md'), 'utf8')).toBe('paid work');
        expect(
          JSON.parse(await readFile(join(artifactsDir, 'nodes', 'later.meta.json'), 'utf8')).nodeId
        ).toBe('later');
      }
      const usage = runUsageWrites(store).at(-1);
      expect(usage?.total_cost_usd).toBeCloseTo(0.3);
      expect(usage).toMatchObject({ total_tokens_in: 30, total_tokens_out: 3 });
    }
  );

  it('carries exchange into a composed fan-out body', async () => {
    await mkdir(join(root, '.archon', 'workflows'), { recursive: true });
    await writeFile(
      join(root, '.archon', 'workflows', 'block.yaml'),
      'name: block\ndescription: Exchange body\nnodes:\n  - id: work\n    prompt: work\n'
    );
    const store = createMockStore();
    const events: string[] = [];
    mockSendQueryDag.mockImplementation(async function* () {
      events.push('invoke');
      yield { type: 'agent_message_chunk', text: 'done' };
      yield { type: 'result' };
    });
    await executeDagWorkflow(
      exchangeOptions({
        deps: createMockDeps(store),
        cwd: root,
        workflowRun: makeWorkflowRun('composed'),
        artifactExchange: {
          async publish() {
            events.push('publish');
          },
          async collect() {
            events.push('collect');
          },
        },
        workflow: {
          name: 'composed',
          nodes: [
            {
              id: 'fan',
              kind: 'compose_fan_out',
              include: 'block',
              fan_out: { items: '[1]', as: 'item', max_parallel: 1, join: 'all_done' },
            },
          ],
        },
      })
    );
    expect(events).toEqual(['publish', 'invoke', 'collect']);
    expect(store.completeWorkflowRun).toHaveBeenCalled();
  });

  it.each(['agent', 'loop'] as const)('collects failed %s attempts before retrying', async kind => {
    const events: string[] = [];
    let attempts = 0;
    const store = createMockStore();
    mockSendQueryDag.mockImplementation(async function* () {
      events.push('invoke');
      attempts++;
      if (attempts === 1) throw new NodeFailure('transient', 'provider transport failed');
      expect(await readFile(join(root, 'collected'), 'utf8')).toBe('attempt 1');
      yield { type: 'agent_message_chunk', text: 'DONE' };
      yield { type: 'result' };
    });
    await executeDagWorkflow(
      exchangeOptions({
        deps: createMockDeps(store),
        cwd: root,
        workflowRun: makeWorkflowRun('retry'),
        artifactExchange: {
          async publish() {
            events.push('publish');
          },
          async collect() {
            events.push('collect');
            await writeFile(join(root, 'collected'), `attempt ${String(attempts)}`);
          },
        },
        workflow: {
          name: 'retry',
          nodes: [
            dagNodeSchema.parse({
              id: 'work',
              retry: { max_attempts: 1, delay_ms: 1000, on_error: 'transient' },
              ...(kind === 'agent'
                ? { prompt: 'work' }
                : { loop: { prompt: 'work', until: 'DONE', max_iterations: 1 } }),
            }),
          ],
        },
      })
    );
    expect(events).toEqual(['publish', 'invoke', 'collect', 'publish', 'invoke', 'collect']);
    expect(store.completeWorkflowRun).toHaveBeenCalled();
  });

  it.each(['agent', 'loop'] as const)(
    'collects before a %s structured reask and preserves listing semantics',
    async kind => {
      const store = createMockStore();
      const artifactsDir = join(root, 'artifacts');
      const events: string[] = [];
      const listings: string[] = [];
      let pending = false;
      mockSendQueryDag.mockImplementation(async function* (prompt) {
        listings.push(prompt.split('\n')[0]);
        events.push('invoke');
        if (listings.length === 1) {
          pending = true;
          yield { type: 'result', structuredOutput: { invalid: true } };
        } else {
          expect(await readFile(join(root, 'collected'), 'utf8')).toBe('first pass');
          yield { type: 'result', structuredOutput: { done: true } };
        }
      });
      await executeDagWorkflow(
        exchangeOptions({
          deps: createMockDeps(store),
          cwd: root,
          artifactsDir,
          workflowRun: makeWorkflowRun('reask'),
          workflowProvider: 'pi',
          artifactExchange: {
            async publish() {
              events.push('publish');
            },
            async collect() {
              events.push('collect');
              if (pending) {
                pending = false;
                await writeFile(join(root, 'collected'), 'first pass');
                await writeNodeArtifact(
                  artifactsDir,
                  {
                    nodeId: 'prior',
                    outputType: 'report',
                    runId: 'reask',
                    producedAt: new Date().toISOString(),
                  },
                  'collected work'
                );
              }
            },
          },
          workflow: {
            name: 'reask',
            nodes: [
              dagNodeSchema.parse({
                id: 'work',
                provider: 'pi',
                output_format: {
                  type: 'object',
                  properties: { done: { type: 'boolean' } },
                  required: ['done'],
                },
                ...(kind === 'agent'
                  ? { prompt: '$TYPED_ARTIFACTS_FILE' }
                  : {
                      loop: {
                        prompt: '$TYPED_ARTIFACTS_FILE',
                        until_field: 'done',
                        max_iterations: 1,
                      },
                    }),
              }),
            ],
          },
        })
      );
      expect(events).toEqual(['publish', 'invoke', 'collect', 'publish', 'invoke', 'collect']);
      expect(store.completeWorkflowRun).toHaveBeenCalled();
      expect(listings).toHaveLength(2);
      expect(listings[0] === listings[1]).toBe(kind === 'agent');
      const first = await readFile(listings[0], 'utf8');
      const second = await readFile(listings[1], 'utf8');
      expect(first).not.toContain('prior');
      expect(second.includes('prior')).toBe(kind === 'loop');
    }
  );

  it('publishes the restored group condition after generating its listing and spill', async () => {
    const store = createMockStore();
    const artifactsDir = join(root, 'artifacts');
    const large = 'z'.repeat(33000);
    const events: string[] = [];
    let publishedListings: string[] = [];
    const exec = spyOnNodeExec().mockImplementation(async (_cmd, _args, options) => {
      events.push('invoke');
      expect(publishedListings).toContain(options?.env?.TYPED_ARTIFACTS_FILE ?? '');
      const spills = await readdir(join(artifactsDir, '.archon', 'node-output-spills'));
      expect(spills.some(f => options?.input?.includes(f))).toBe(true);
      return { stdout: '', stderr: '' };
    });
    try {
      await executeDagWorkflow(
        exchangeOptions({
          deps: createMockDeps(store),
          cwd: root,
          artifactsDir,
          artifactExchange: {
            async publish() {
              events.push('publish');
              const dir = join(artifactsDir, '.archon', 'typed-artifacts');
              const files = await readdir(dir);
              publishedListings = files.map(file => join(dir, file));
              expect(publishedListings.length).toBeGreaterThan(0);
              for (const listing of publishedListings) {
                expect(await readFile(listing, 'utf8')).toContain('artifactsByType');
              }
              const spills = await readdir(join(artifactsDir, '.archon', 'node-output-spills'));
              expect(
                await readFile(
                  join(artifactsDir, '.archon', 'node-output-spills', spills[0]),
                  'utf8'
                )
              ).toBe(large);
            },
            async collect() {
              events.push('collect');
            },
          },
          workflowRun: makeWorkflowRun('restored', {
            metadata: {
              approval: {
                type: 'approval',
                nodeId: 'group',
                bodyGateId: 'check',
                iteration: 1,
                message: 'continue',
                decisions: [{ id: 'approve' }, { id: 'revise' }],
                decisionsAuthored: true,
              },
            },
          }),
          priorCompletedNodes: new Map([
            ['group.work', { output: large }],
            [
              'group.check',
              { output: '{"decision":"approve"}', structuredOutput: { decision: 'approve' } },
            ],
          ]),
          workflow: {
            name: 'restored',
            nodes: [
              dagNodeSchema.parse({
                id: 'group',
                loop_group: {
                  max_iterations: 2,
                  until_bash: 'value=$work.output; test -n "$value"',
                  nodes: [
                    { id: 'work', prompt: 'work' },
                    {
                      id: 'check',
                      depends_on: ['work'],
                      approval: {
                        message: 'continue',
                        decisions: [{ id: 'approve' }, { id: 'revise' }],
                      },
                    },
                  ],
                },
              }),
            ],
          },
        })
      );
      expect(events).toEqual(['publish', 'invoke', 'collect']);
      expect(mockSendQueryDag).not.toHaveBeenCalled();
      expect(
        store.createWorkflowEvent.mock.calls.find(([e]) => e.event_type === 'node_failed')
      ).toBeUndefined();
      expect(store.completeWorkflowRun).toHaveBeenCalled();
    } finally {
      exec.mockRestore();
    }
  });

  it.each(['loop', 'group'] as const)(
    'fails a %s condition on collection refusal instead of treating it as false',
    async kind => {
      let collections = 0;
      const store = createMockStore();
      mockSendQueryDag.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'work' };
        yield { type: 'result' };
      });
      const exec = spyOnNodeExec().mockResolvedValue({ stdout: '', stderr: '' });
      try {
        await executeDagWorkflow(
          exchangeOptions({
            deps: createMockDeps(store),
            cwd: root,
            workflowRun: makeWorkflowRun('refusal'),
            artifactExchange: {
              async publish() {},
              async collect() {
                if (++collections === 2)
                  throw Object.assign(new Error('linked parent refused'), { code: 1 });
              },
            },
            workflow: {
              name: 'refusal',
              nodes: [
                dagNodeSchema.parse(
                  kind === 'loop'
                    ? {
                        id: 'work',
                        loop: { prompt: 'work', until_bash: 'false', max_iterations: 3 },
                      }
                    : {
                        id: 'work',
                        loop_group: {
                          until_bash: 'false',
                          max_iterations: 3,
                          nodes: [{ id: 'body', prompt: 'work' }],
                        },
                      }
                ),
              ],
            },
          })
        );
        expect(collections).toBe(2);
        expect(store.completeWorkflowRun).not.toHaveBeenCalled();
        expect(store.createWorkflowEvent.mock.calls).toEqual(
          expect.arrayContaining([
            [
              expect.objectContaining({
                event_type: 'node_failed',
                data: expect.objectContaining({
                  error: expect.stringContaining('Artifact collect failed'),
                }),
              }),
            ],
          ])
        );
      } finally {
        exec.mockRestore();
      }
    }
  );

  it('surfaces a stream collection refusal even when cancellation aborted the agent', async () => {
    const store = createMockStore();
    let cancelled = false;
    store.getWorkflowRunStatus.mockImplementation(async () =>
      cancelled ? 'cancelled' : 'running'
    );
    mockSendQueryDag.mockImplementation(async function* () {
      cancelled = true;
      yield { type: 'agent_message_chunk', text: 'partial work' };
    });
    await executeDagWorkflow(
      exchangeOptions({
        deps: createMockDeps(store),
        cwd: root,
        workflowRun: makeWorkflowRun('cancelled-stream'),
        artifactExchange: {
          async publish() {},
          async collect() {
            throw new Error('collection refused');
          },
        },
        workflow: {
          name: 'cancelled-stream',
          nodes: [dagNodeSchema.parse({ id: 'work', prompt: 'work' })],
        },
      })
    );
    expect(
      store.createWorkflowEvent.mock.calls.some(
        ([e]) =>
          e.event_type === 'node_failed' &&
          e.data?.error === 'Artifact collect failed' &&
          e.data?.failure_kind === 'unknown'
      )
    ).toBe(true);
  });

  it('collects a cancelled deterministic invocation before recording its failure', async () => {
    const store = createMockStore();
    const events: string[] = [];
    const exec = spyOnNodeExec().mockRejectedValue(
      Object.assign(new Error('cancelled'), { cancelled: true })
    );
    try {
      await executeDagWorkflow(
        exchangeOptions({
          deps: createMockDeps(store),
          cwd: root,
          workflowRun: makeWorkflowRun('cancel'),
          artifactExchange: {
            async publish() {
              events.push('publish');
            },
            async collect() {
              expect(
                store.createWorkflowEvent.mock.calls.some(([e]) => e.event_type === 'node_failed')
              ).toBe(false);
              events.push('collect');
            },
          },
          workflow: { name: 'cancel', nodes: [dagNodeSchema.parse({ id: 'work', bash: 'work' })] },
        })
      );
      expect(events).toEqual(['publish', 'collect']);
      expect(
        store.createWorkflowEvent.mock.calls.some(
          ([e]) => e.event_type === 'node_failed' && e.data?.failure_kind === 'cancelled'
        )
      ).toBe(true);
    } finally {
      exec.mockRestore();
    }
  });

  it.each([false, true])(
    'publishes nested group listings and oversized spills before conditions (resumed=%s)',
    async resumed => {
      const artifactsDir = join(root, 'artifacts');
      const store = createMockStore();
      let publishes = 0;
      let collections = 0;
      let publishedFiles: string[] = [];
      const walk = async (dir: string): Promise<string[]> => {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        return (
          await Promise.all(
            entries.map(e => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
          )
        ).flat();
      };
      const large = 'x'.repeat(33000);
      mockSendQueryDag.mockImplementation(async function* () {
        expect(publishes).toBeGreaterThan(collections);
        yield { type: 'agent_message_chunk', text: large };
        yield { type: 'result' };
      });
      let conditions = 0;
      const exec = spyOnNodeExec().mockImplementation(async (_cmd, _args, options) => {
        conditions++;
        const listing = options?.env?.TYPED_ARTIFACTS_FILE;
        expect(listing).toBeDefined();
        expect(publishedFiles).toContain(listing ?? '');
        const script = options?.input ?? '';
        const spills = publishedFiles.filter(f => f.endsWith('.nodeoutput'));
        expect(spills.some(f => script.includes(f) && existsSync(f))).toBe(true);
        expect(await readFile(spills.find(f => script.includes(f)) ?? '', 'utf8')).toBe(large);
        return { stdout: '', stderr: '' };
      });
      try {
        await executeDagWorkflow(
          exchangeOptions({
            deps: createMockDeps(store),
            cwd: root,
            artifactsDir,
            workflowRun: makeWorkflowRun(
              'nested',
              resumed
                ? {
                    metadata: {
                      approval: {
                        type: 'interactive_loop',
                        nodeId: 'outer',
                        iteration: 1,
                        sessionId: 'session',
                        sessionProvider: 'claude',
                        message: 'continue',
                      },
                      loop_user_input: 'continue',
                    },
                  }
                : {}
            ),
            artifactExchange: {
              async publish() {
                publishes++;
                publishedFiles = await walk(artifactsDir);
              },
              async collect() {
                collections++;
              },
            },
            workflow: {
              name: 'nested',
              nodes: [
                dagNodeSchema.parse({
                  id: 'outer',
                  loop_group: {
                    max_iterations: 2,
                    until_bash: 'value=$inner.output; test -n "$value"',
                    nodes: [
                      {
                        id: 'inner',
                        loop_group: {
                          max_iterations: 1,
                          until_bash: 'value=$body.output; test -n "$value"',
                          nodes: [{ id: 'body', prompt: 'work', output_type: 'report' }],
                        },
                      },
                    ],
                  },
                }),
              ],
            },
          })
        );
        expect(conditions).toBe(2);
        expect(publishes).toBe(collections);
        expect(store.completeWorkflowRun).toHaveBeenCalled();
      } finally {
        exec.mockRestore();
      }
    }
  );
});
