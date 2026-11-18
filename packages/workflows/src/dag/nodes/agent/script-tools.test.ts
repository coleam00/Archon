// @archon-test-isolated
import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import * as runControl from '../../run-control';
import { NodeFailure } from '../../ai-turn';
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
  minimalConfig,
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
const run = (nodes: DagNode[] = [agent()], provider = 'claude', credentials?: string[]) =>
  executeDagWorkflow(
    dagOptions({
      deps,
      platform: createMockPlatform(),
      cwd: root,
      workflowRun: makeWorkflowRun(),
      workflowProvider: provider,
      workflow: { name: 'tools', nodes },
      config: credentials
        ? { ...minimalConfig, protectedCredentialValues: credentials }
        : minimalConfig,
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
      throw new NodeFailure('rate_limited', 'provider transport failed', {
        class: 'rate_limited',
        evidence: 'rate limited',
      });
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
    expect(failed?.data).toMatchObject({
      failure_kind: 'unknown',
      provider_failure: { class: 'rate_limited' },
    });
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
  const started = Promise.withResolvers<void>();
  const exec = spyOn(runControl, 'runSubprocessUntilRunStops').mockImplementation(
    async (_store, _runId, _nodeId, _context, _cmd, _args, options) => {
      const signal = options.abortSignal;
      if (!signal) throw new Error('Missing abort signal');
      started.resolve();
      if (!signal.aborted) {
        await new Promise<void>(resolve =>
          signal.addEventListener('abort', () => resolve(), { once: true })
        );
      }
      throw Object.assign(new Error('write cancelled'), { cancelled: true, code: null });
    }
  );
  try {
    let work: Promise<string> | undefined;
    mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
      work = options?.nativeTools?.[0].handler(args);
      void work?.catch(() => undefined);
      await started.promise;
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

test('a certified null result stays null in the call event', async () => {
  const node = agent();
  if (!node.tools) throw new Error('Missing tool declaration');
  node.tools.lookup.output_schema = { type: 'null' };
  await writeFile(join(root, '.archon', 'scripts', 'lookup.ts'), 'console.log("null");');
  mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
    expect(await options?.nativeTools?.[0].handler(args)).toBe('null');
    yield reply();
  });
  await run([node]);
  expect(events('script_tool_call')[0]?.data?.output).toBeNull();
});

test('call events recursively redact protected values without changing the tool result', async () => {
  const node = agent();
  if (!node.tools) throw new Error('Missing tool declaration');
  node.tools.lookup.output_schema = {
    type: 'object',
    properties: {
      nested: {
        type: 'object',
        properties: {
          secret: { type: 'string' },
          count: { type: 'number' },
          values: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  };
  await writeFile(
    join(root, '.archon', 'scripts', 'lookup.ts'),
    'const input=JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({nested:{secret:`prefix ${input.payload}`,count:7,values:[input.payload]}}));'
  );
  mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
    const result = await options?.nativeTools?.[0].handler({
      ...args,
      payload: 'secret-value',
    });
    expect(result).toContain('secret-value');
    yield reply();
  });
  await run([node], 'claude', ['secret-value']);
  expect(events('script_tool_call')[0]?.data).toMatchObject({
    input: { payload: '[REDACTED]' },
    output: { nested: { secret: 'prefix [REDACTED]', count: 7, values: ['[REDACTED]'] } },
  });
});

test('a stalled unknown-event write cannot block shutdown past the second grace', async () => {
  const launched = Promise.withResolvers<void>();
  const exec = spyOn(runControl, 'runSubprocessUntilRunStops').mockImplementation(async () => {
    launched.resolve();
    return new Promise<never>(() => undefined);
  });
  const persist = deps.store.persistWorkflowEvent.getMockImplementation();
  if (!persist) throw new Error('Missing persistWorkflowEvent implementation');
  deps.store.persistWorkflowEvent.mockImplementation(async event => {
    if (event.event_type === 'script_tool_call') return new Promise<void>(() => undefined);
    return persist(event);
  });
  try {
    mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
      const work = options?.nativeTools?.[0].handler(args);
      void work?.catch(() => undefined);
      await launched.promise;
      yield reply();
    });
    const started = Date.now();
    await run([agent(true)]);
    expect(Date.now() - started).toBeLessThan(3500);
    expect(events('node_failed')[0]?.data).toMatchObject({
      failure_kind: 'unknown',
      retryable: false,
      error: expect.stringContaining('did not settle'),
    });
    expect(events('script_tool_call')).toHaveLength(0);
  } finally {
    exec.mockRestore();
  }
});

test('a stopped attempt cannot launch a write after its source recheck', async () => {
  const gate = Promise.withResolvers<void>();
  const rechecking = Promise.withResolvers<void>();
  const readFile = fs.readFile;
  let checking = false;
  const read = spyOn(fs, 'readFile').mockImplementation((async (
    path: Parameters<typeof fs.readFile>[0],
    options?: Parameters<typeof fs.readFile>[1]
  ) => {
    if (checking && String(path).endsWith('lookup.ts')) {
      rechecking.resolve();
      await gate.promise;
    }
    return readFile(path, options);
  }) as typeof fs.readFile);
  const exec = spyOn(runControl, 'runSubprocessUntilRunStops').mockResolvedValue({
    stdout: '{"green":false}',
    stderr: '',
    credentialValues: [],
  });
  try {
    let work: Promise<string> | undefined;
    mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
      checking = true;
      work = options?.nativeTools?.[0].handler(args);
      void work?.catch(() => undefined);
      await rechecking.promise;
      yield reply();
      setTimeout(() => gate.resolve(), 20);
    });
    await run([agent(true)]);
    await expect(work).rejects.toThrow('before script start');
    expect(exec).not.toHaveBeenCalled();
    expect(events('node_failed')[0]?.data).toMatchObject({
      failure_kind: 'unknown',
      retryable: false,
    });
  } finally {
    read.mockRestore();
    exec.mockRestore();
  }
});
