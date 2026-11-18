// @archon-test-isolated
import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import * as runControl from '../../run-control';
import { executeDagWorkflow } from '../../../dag-executor';
import { renderOutputTypes } from '../../../output-types';
import { qualifyWorkflowResources } from '../../../packaged-workflow';
import type { AgentNode, DagNode } from '../../../schemas';
import { validateNodeOutputFormats } from '../../../loader/contracts';
import {
  createMockDeps,
  createMockPlatform,
  dagOptions,
  makeWorkflowRun,
  mockSendQueryDag,
  persistedEvents,
  spyOnNodeExec,
  type MockWorkflowStore,
} from '../../test-utils';

let root: string;
let deps: ReturnType<typeof createMockDeps<MockWorkflowStore>>;
const events = (type: string) =>
  persistedEvents(deps.store).filter(event => event.event_type === type);
const inputSchema = {
  type: 'object',
  properties: {
    count: { type: 'number' },
    payload: { type: 'string' },
    items: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    },
  },
  required: ['count', 'items'],
  additionalProperties: false,
};
const args = { count: 2.5, items: [{ id: 7 }] };
const tool = {
  description: 'Look up checks',
  script: 'lookup',
  input_schema: inputSchema,
  output_schema: {
    type: 'object',
    properties: { green: { type: 'boolean' } },
    required: ['green'],
    additionalProperties: false,
  },
  writes: false,
};
const agent = (writes = false): AgentNode => ({
  kind: 'agent',
  source: { kind: 'inline', prompt: 'Use lookup then report' },
  id: 'inspect',
  tools: { lookup: { ...tool, writes } },
  output_format: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      metrics: { type: 'array', items: { type: 'object' } },
    },
    required: ['summary'],
  },
});
const run = (nodes: DagNode[] = [agent()], provider = 'claude') =>
  executeDagWorkflow(
    dagOptions({
      deps,
      platform: createMockPlatform(),
      cwd: root,
      workflowRun: makeWorkflowRun(),
      workflowProvider: provider,
      workflow: { name: 'tools', nodes },
    })
  );
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-tools-lite-'));
  await mkdir(join(root, '.archon', 'scripts'), { recursive: true });
  await writeFile(
    join(root, '.archon', 'scripts', 'lookup.ts'),
    'if (process.env.ARCHON_TOOL_INPUT) throw new Error("input used env"); const input = JSON.parse(await Bun.stdin.text()); if (input.count !== 2.5 || input.items[0].id !== 7) throw new Error("wrong input"); console.log(JSON.stringify({green:false}));'
  );
  deps = createMockDeps();
  mockSendQueryDag.mockClear();
});
afterEach(async () => {
  await removeTempTree(root);
});
const reply = () => ({
  type: 'result' as const,
  text: '{"summary":"Checks are red","metrics":[]}',
  structuredOutput: { summary: 'Checks are red', metrics: [] },
});

test('engine validates complex stdin input, records one call, and leaves agent output unchanged', async () => {
  mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _resume, options) {
    const native = options?.nativeTools?.[0];
    if (!native) throw new Error('Missing tool');
    expect(await native.handler(args, { providerCallId: 'call-7' })).toBe('{"green":false}');
    yield reply();
  });
  await run();
  const calls = events('script_tool_call');
  expect(calls).toHaveLength(1);
  expect(calls[0].data).toMatchObject({
    provider_call_id: 'call-7',
    input: args,
    output: { green: false },
    status: 'completed',
  });
  expect(events('node_completed')[0]?.data?.structured_output).toEqual(reply().structuredOutput);
});

test('stdin carries a tool input larger than the Linux per-variable limit', async () => {
  mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
    const input = { ...args, payload: 'x'.repeat(140 * 1024) };
    expect(await options?.nativeTools?.[0].handler(input)).toBe('{"green":false}');
    yield reply();
  });
  await run();
  expect(events('script_tool_call')[0]?.data?.input).toMatchObject({
    payload: expect.stringMatching(/^x{143360}$/),
  });
  expect(events('node_failed')).toHaveLength(0);
});

test.each([
  { count: 'wrong', items: [] },
  { count: 1, items: [{ id: 'wrong' }] },
])('invalid input starts no script: %p', async input => {
  const exec = spyOnNodeExec().mockResolvedValue({ stdout: '', stderr: '' });
  try {
    mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
      await expect(options?.nativeTools?.[0].handler(input)).rejects.toThrow('Invalid input');
      yield reply();
    });
    await run();
    expect(events('node_failed')).toHaveLength(0);
    expect(exec.mock.calls.filter(([cmd]) => cmd === 'bun')).toHaveLength(0);
    expect(events('script_tool_call')).toHaveLength(1);
  } finally {
    exec.mockRestore();
  }
});

test.each([
  {
    writes: false,
    body: 'console.error("checks are red");process.exit(2);',
    error: 'checks are red',
  },
  { writes: true, body: 'process.exit(3);', error: 'failed' },
  { writes: false, body: 'console.log(JSON.stringify({green:"wrong"}));', error: 'output_format' },
])('ordinary failure returns a tool error: %p', async ({ writes, body, error }) => {
  await writeFile(join(root, '.archon', 'scripts', 'lookup.ts'), body);
  mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
    await expect(options?.nativeTools?.[0].handler(args)).rejects.toThrow(error);
    yield reply();
  });
  await run([agent(writes)]);
  expect(events('node_failed')).toHaveLength(0);
  expect(events('script_tool_call')[0]?.data?.status).toBe('failed');
});

test('write timeout stops the node non-retryably and preserves provider failure', async () => {
  const exec = spyOnNodeExec().mockRejectedValue(
    Object.assign(new Error('write timed out'), { timedOut: true, code: null })
  );
  try {
    mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
      await expect(options?.nativeTools?.[0].handler(args)).rejects.toThrow();
      throw new Error('provider transport failed');
      yield reply();
    });
    const node = {
      ...agent(true),
      retry: { max_attempts: 3, delay_ms: 1000, on_error: 'all' as const },
    };
    await run([node]);
    const failed = events('node_failed')[0];
    expect(failed?.data).toMatchObject({ retryable: false });
    expect(failed?.data?.error).toContain('provider transport failed');
    expect(mockSendQueryDag.mock.calls).toHaveLength(1);
    expect(events('script_tool_call')[0]?.data?.status).toBe('unknown');
  } finally {
    exec.mockRestore();
  }
});

test('unsupported tools provider is refused without invoking model', async () => {
  await expect(run([agent()], 'opencode')).rejects.toThrow('nativeTools');
  expect(mockSendQueryDag.mock.calls).toHaveLength(0);
});

test('invalid tool schemas fail load and pack qualification leaves output types unchanged', () => {
  const node = agent();
  const broken = {
    ...node,
    tools: {
      lookup: {
        ...tool,
        input_schema: { type: 'object', properties: { id: { $ref: '#/missing' } } },
      },
    },
  };
  expect(validateNodeOutputFormats([broken])).toContain('cannot be compiled');
  const workflow = { name: 'tools', description: 'tools', nodes: [node] };
  qualifyWorkflowResources(workflow, { source: 'project', pack: 'checks', workflow: 'inspect' });
  expect(node.tools?.lookup.script).toContain('checks:inspect::lookup');
  const rendered = renderOutputTypes('archon workflow types tools', [workflow]);
  expect(rendered.content).not.toContain('tool_calls');
  expect(rendered.content).toContain('summary: string');
});

test('no-schema agent keeps its original text output', async () => {
  mockSendQueryDag.mockImplementation(async function* () {
    yield { type: 'result', text: 'plain answer' };
  });
  await run([{ ...agent(), output_format: undefined }]);
  expect(events('node_completed')[0]?.data?.node_output).toBe('plain answer');
  expect(events('node_completed')[0]?.data?.structured_output).toBeUndefined();
});

test('an unsettled provider with a pending write is cancelled and cannot complete or retry', async () => {
  const exec = spyOn(runControl, 'runSubprocessUntilRunStops').mockImplementation(
    async (_store, _runId, _nodeId, _context, _cmd, _args, options) => {
      const signal = options.abortSignal;
      if (!signal) throw new Error('Missing abort signal');
      await new Promise<void>(resolve =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      );
      throw Object.assign(new Error('write cancelled'), { cancelled: true, code: null });
    }
  );
  try {
    let work: Promise<string> | undefined;
    mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
      work = options?.nativeTools?.[0].handler(args);
      void work?.catch(() => undefined);
      yield reply();
    });
    await run([agent(true)]);
    await expect(work).rejects.toThrow();
    expect(events('node_failed').at(-1)?.data).toMatchObject({
      retryable: false,
      failure_kind: 'unknown',
      error: expect.stringContaining('Tool write outcome unknown'),
    });
    expect(events('script_tool_call')).toHaveLength(1);
  } finally {
    exec.mockRestore();
  }
});

test('stop bounds a hung write, records unknown once, and fails instead of completing', async () => {
  let rejectScript: ((error: Error) => void) | undefined;
  const exec = spyOn(runControl, 'runSubprocessUntilRunStops').mockImplementation(
    async () =>
      new Promise<never>((_resolve, reject) => {
        rejectScript = reject;
      })
  );
  try {
    let work: Promise<string> | undefined;
    mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
      work = options?.nativeTools?.[0].handler(args);
      void work?.catch(() => undefined);
      yield reply();
    });
    await run([agent(true)]);
    expect(events('node_failed')[0]?.data).toMatchObject({
      retryable: false,
      failure_kind: 'unknown',
      error: expect.stringContaining('did not settle'),
    });
    expect(events('script_tool_call')).toHaveLength(1);
    expect(events('script_tool_call')[0]?.data?.status).toBe('unknown');
    rejectScript?.(Object.assign(new Error('late cancellation'), { cancelled: true }));
    await expect(work).rejects.toThrow('late cancellation');
    await Promise.resolve();
    expect(events('script_tool_call')).toHaveLength(1);
  } finally {
    exec.mockRestore();
  }
});

test('a no-tools schema failure after the model retains provider spend', async () => {
  mockSendQueryDag.mockImplementation(async function* () {
    yield {
      ...reply(),
      cost: 0.01,
      tokens: { input: 10, output: 2 },
    };
  });
  const node: AgentNode = {
    kind: 'agent',
    id: 'inspect',
    source: { kind: 'inline', prompt: 'Return JSON' },
    output_format: { type: 'object', properties: { id: { $ref: '#/missing' } } },
  };
  await run([node]);
  expect(events('node_failed')[0]?.data).toMatchObject({
    failure_kind: 'config',
    cost_usd: 0.01,
  });
});
