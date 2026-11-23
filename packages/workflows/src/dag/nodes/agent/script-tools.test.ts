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
import { dagNodeSchema, type AgentNode, type DagNode } from '../../../schemas';
import { validateNodeOutputFormats } from '../../../loader/contracts';
import {
  captureWorkflowSource,
  capturedSourceRoots,
  WorkflowSourceUnavailableError,
} from '../../../workflow-source';
import * as sourceLoader from '../../../workflow-source/load';
import * as scriptExecution from '../exec/script';
import { RunSourceUnreadableError } from '../../node-source';
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
  const payload = Array.from({ length: 5000 }, () => crypto.randomUUID()).join('');
  let returned: string | undefined;
  mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
    returned = await options?.nativeTools?.[0].handler({ ...args, payload });
    yield reply();
  });
  await run();
  expect(payload.length).toBeGreaterThan(128 * 1024);
  expect(returned).toBe('{"green":false}');
  expect(events('script_tool_call')[0]?.data?.input).toMatchObject({ payload });
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

test.each(['top', 'group', 'nested-group', 'compose', 'compose-all-done-group'] as const)(
  'an unknown write blocks automatic continuation through %s',
  async scope => {
    const exec = spyOnNodeExec().mockRejectedValue(
      Object.assign(new Error('write timed out'), { timedOut: true, code: null })
    );
    const writingNode = {
      ...agent(true),
      retry: { max_attempts: 3, delay_ms: 0, on_error: 'all' as const },
    };
    const group = (id: string, child: DagNode): DagNode => ({
      id,
      kind: 'loop_group',
      loop_group: { max_iterations: 2, until: 'DONE', nodes: [child], fresh_context: false },
    });
    let node: DagNode = writingNode;
    if (scope === 'group') node = group('outer', writingNode);
    if (scope === 'nested-group') node = group('outer', group('inner', writingNode));
    if (scope === 'compose' || scope === 'compose-all-done-group') {
      await mkdir(join(root, '.archon', 'workflows'), { recursive: true });
      await writeFile(
        join(root, '.archon', 'workflows', 'write-block.yaml'),
        `name: write-block
description: One guarded write
mutates_checkout: false
nodes:
  - id: inspect
    prompt: Call lookup once
    tools:
      lookup:
        description: Guarded write
        script: lookup
        writes: true
        input_schema:
          type: object
        output_schema:
          type: object
`
      );
      const composed = dagNodeSchema.parse({
        id: 'fan',
        include: 'write-block',
        fan_out: {
          items: '[1]',
          as: 'item',
          join: scope === 'compose' ? 'all_success' : 'all_done',
          max_parallel: 1,
        },
      });
      if (composed.kind !== 'compose_fan_out') throw new Error('Expected composed fan-out');
      node = composed;
      if (scope === 'compose-all-done-group') node = group('outer', composed);
    }
    let handlerCalls = 0;
    try {
      mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
        handlerCalls++;
        try {
          await options?.nativeTools?.[0].handler(args);
        } catch {}
        throw new NodeFailure('rate_limited', 'provider transport failed', {
          class: 'rate_limited',
          evidence: 'rate limited',
          resetAt: new Date(Date.now() + 60_000).toISOString(),
        });
        yield reply();
      });
      await run([node]);
      expect(handlerCalls).toBe(1);
      expect(events('script_tool_call')).toHaveLength(1);
      expect(events('script_tool_call')[0]?.data?.status).toBe('unknown');
      expect(events('node_failed').some(event => event.data?.failure_kind === 'unknown')).toBe(
        true
      );
      const finalFailure = events('node_failed').at(-1);
      expect(finalFailure?.data).toMatchObject({
        retryable: false,
        provider_failure: { class: 'rate_limited' },
      });
      expect(deps.store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
      expect(deps.store.failWorkflowRun).toHaveBeenCalledTimes(1);
    } finally {
      exec.mockRestore();
    }
  }
);

test.each(['top', 'group', 'compose', 'compose-instances'] as const)(
  'a sibling source error cannot release an unknown write through %s',
  async scope => {
    const started = Promise.withResolvers<void>();
    const exec = spyOnNodeExec().mockImplementation(async () => {
      started.resolve();
      throw Object.assign(new Error('write timed out'), { timedOut: true, code: null });
    });
    const prepare = scriptExecution.prepareToolScript;
    let preparationCalls = 0;
    const source = spyOn(scriptExecution, 'prepareToolScript').mockImplementation(
      async (ctx, node, execution) => {
        preparationCalls++;
        if (scope === 'compose-instances' ? preparationCalls === 2 : node.id.includes('recover')) {
          await started.promise;
          throw new RunSourceUnreadableError(
            node.id,
            new WorkflowSourceUnavailableError(join(root, 'capture'), new Error('read denied'))
          );
        }
        return prepare(ctx, node, execution);
      }
    );
    const sibling: AgentNode = { ...agent(), id: 'recover' };
    let nodes: DagNode[] = [agent(true), sibling];
    if (scope === 'group')
      nodes = [
        {
          id: 'outer',
          kind: 'loop_group',
          loop_group: { max_iterations: 2, until: 'DONE', fresh_context: false, nodes },
        },
      ];
    if (scope === 'compose' || scope === 'compose-instances') {
      await mkdir(join(root, '.archon', 'workflows'), { recursive: true });
      await writeFile(
        join(root, '.archon', 'workflows', 'recover-block.yaml'),
        `name: recover-block
description: Unreadable sibling
mutates_checkout: false
nodes:
  - id: ${scope === 'compose-instances' ? 'inspect' : 'recover'}
    prompt: Use lookup
    tools:
      lookup:
        description: Read source
        script: lookup
        writes: true
        input_schema: {type: object}
        output_schema: {type: object}
`
      );
      const fan = dagNodeSchema.parse({
        id: 'fan',
        include: 'recover-block',
        fan_out: {
          items: scope === 'compose-instances' ? '[1,2]' : '[1]',
          as: 'item',
          join: 'all_success',
          max_parallel: 2,
        },
      });
      if (fan.kind !== 'compose_fan_out') throw new Error('Expected composed fan-out');
      nodes = scope === 'compose-instances' ? [fan] : [agent(true), fan];
    }
    let handlerCalls = 0;
    try {
      mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
        handlerCalls++;
        try {
          await options?.nativeTools?.[0].handler(args);
        } catch {}
        yield reply();
      });
      await run(nodes);
      expect(handlerCalls).toBe(1);
      expect(events('script_tool_call')).toHaveLength(1);
      expect(events('script_tool_call')[0]?.data?.status).toBe('unknown');
      expect(deps.store.releaseRunForUnreadableSource).not.toHaveBeenCalled();
      expect(deps.store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
      expect(deps.store.failWorkflowRun).toHaveBeenCalledTimes(1);
    } finally {
      source.mockRestore();
      exec.mockRestore();
    }
  }
);

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
  expect(
    validateNodeOutputFormats([
      {
        ...node,
        tools: { lookup: { ...tool, output_schema: { ...tool.output_schema, $async: true } } },
      },
    ])
  ).toContain('output_schema must be synchronous');
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
  const started = Promise.withResolvers<void>();
  const script = Promise.withResolvers<never>();
  const exec = spyOn(runControl, 'runSubprocessUntilRunStops').mockImplementation(async () => {
    started.resolve();
    return script.promise;
  });
  try {
    let work: Promise<string> | undefined;
    mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
      work = options?.nativeTools?.[0].handler(args);
      void work?.catch(() => undefined);
      await started.promise;
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
    script.reject(Object.assign(new Error('late cancellation'), { cancelled: true }));
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
  let result: string | undefined;
  mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
    result = await options?.nativeTools?.[0].handler(args);
    yield reply();
  });
  await run([node]);
  expect(events('node_completed')).toHaveLength(1);
  expect(result).toBe('null');
  expect(events('script_tool_call')[0]?.data?.output).toBeNull();
});

test.each([false, true])(
  'redacts audit keys and values without changing stdin or the result (reverse: %s)',
  async reverse => {
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
            names: { type: 'object' },
          },
        },
      },
    };
    await writeFile(
      join(root, '.archon', 'scripts', 'lookup.ts'),
      'const input=JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({nested:{secret:`prefix ${input.payload}`,count:7,values:[input.payload],names:input.items[0].names}}));'
    );
    const names = reverse
      ? {
          '[REDACTED]#1': 4,
          '[REDACTED]': 3,
          'second-secret': 2,
          'secret-value': 1,
          ordinary: null,
        }
      : {
          'secret-value': 1,
          'second-secret': 2,
          '[REDACTED]': 3,
          '[REDACTED]#1': 4,
          ordinary: null,
        };
    let result: string | undefined;
    mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
      result = await options?.nativeTools?.[0].handler({
        ...args,
        payload: 'secret-value',
        items: [{ id: 7, names }],
      });
      yield reply();
    });
    await run([node], 'claude', ['secret-value', 'second-secret']);
    expect(events('node_completed')).toHaveLength(1);
    expect(result && JSON.parse(result)).toEqual({
      nested: { secret: 'prefix secret-value', count: 7, values: ['secret-value'], names },
    });
    const redacted = {
      '[REDACTED]': 3,
      '[REDACTED]#1': 4,
      '[REDACTED]#2': reverse ? 2 : 1,
      '[REDACTED]#3': reverse ? 1 : 2,
      ordinary: null,
    };
    const event = events('script_tool_call')[0]?.data;
    expect(event?.input).toEqual({
      ...args,
      payload: '[REDACTED]',
      items: [{ id: 7, names: redacted }],
    });
    expect(event?.output).toEqual({
      nested: { secret: 'prefix [REDACTED]', count: 7, values: ['[REDACTED]'], names: redacted },
    });
  }
);

test('invalid input redacts inherited credentials without starting a script', async () => {
  const key = 'REVIEW_INHERITED_SECRET';
  const previous = process.env[key];
  const secret = 'invalid-input-inherited-credential';
  process.env[key] = secret;
  const exec = spyOnNodeExec().mockResolvedValue({ stdout: '', stderr: '' });
  let error: unknown;
  try {
    mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
      try {
        await options?.nativeTools?.[0].handler({
          count: 'wrong',
          payload: secret,
          items: [{ id: 7, [secret]: secret }],
        });
      } catch (cause) {
        error = cause;
      }
      yield reply();
    });
    await run();
    expect(String(error)).toContain('Invalid input');
    expect(exec.mock.calls.filter(([command]) => command === 'bun')).toHaveLength(0);
    expect(events('script_tool_call')).toHaveLength(1);
    expect(events('script_tool_call')[0]?.data?.status).toBe('failed');
    expect(JSON.stringify(events('script_tool_call'))).not.toContain(secret);
  } finally {
    exec.mockRestore();
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test('omits only an unsafe audit field when a credential matches the marker', async () => {
  let result: string | undefined;
  mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
    result = await options?.nativeTools?.[0].handler({ ...args, payload: '[REDACTED]' });
    yield reply();
  });
  await run([agent()], 'claude', ['[REDACTED]']);
  expect(events('node_completed')).toHaveLength(1);
  expect(result).toBe('{"green":false}');
  const event = events('script_tool_call')[0]?.data;
  expect(event).toMatchObject({
    status: 'completed',
    input_redaction_failed: true,
    output: { green: false },
  });
  expect(event).not.toHaveProperty('input');
});

test.each([
  { field: 'input', inputCount: 424242, outputCount: 7 },
  { field: 'output', inputCount: 7, outputCount: 424242 },
] as const)('omits the audit $field on a numeric credential match', async row => {
  const node = agent();
  if (!node.tools) throw new Error('Missing tool declaration');
  node.tools.lookup.output_schema = {
    type: 'object',
    properties: { counts: { type: 'array', items: { type: 'integer' } } },
    required: ['counts'],
  };
  await writeFile(
    join(root, '.archon', 'scripts', 'lookup.ts'),
    'const input = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({counts:[424249 - input.count]}));'
  );
  const input = { ...args, count: row.inputCount };
  const output = { counts: [row.outputCount] };
  mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
    expect(await options?.nativeTools?.[0].handler(input)).toBe(JSON.stringify(output));
    yield reply();
  });
  await run([node], 'claude', ['424242']);
  expect(events('node_completed')).toHaveLength(1);
  const calls = events('script_tool_call');
  expect(calls).toHaveLength(1);
  expect(calls[0].data).toMatchObject({
    status: 'completed',
    [`${row.field}_redaction_failed`]: true,
    ...(row.field === 'input' ? { output } : { input }),
  });
  expect(calls[0].data).not.toHaveProperty(row.field);
});

test('redacts a recorded tool error without replacing the audit status', async () => {
  await writeFile(
    join(root, '.archon', 'scripts', 'lookup.ts'),
    'console.error("fixture-credential"); process.exit(1);'
  );
  let rejected = false;
  mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
    try {
      await options?.nativeTools?.[0].handler(args);
    } catch {
      rejected = true;
    }
    yield reply();
  });
  await run([agent()], 'claude', ['fixture-credential']);
  expect(rejected).toBe(true);
  expect(events('node_completed')).toHaveLength(1);
  expect(events('script_tool_call')[0]?.data).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('[REDACTED]'),
  });
  expect(String(events('script_tool_call')[0]?.data?.error)).not.toContain('fixture-credential');
});

test.each([false, true])(
  'failed calls redact inherited credentials in audit keys and values (writes: %s)',
  async writes => {
    const key = 'REVIEW_INHERITED_SECRET';
    const previous = process.env[key];
    const secret = 'review-inherited-credential';
    process.env[key] = secret;
    let actualInput: Record<string, unknown> | undefined;
    let error: unknown;
    try {
      await writeFile(
        join(root, '.archon', 'scripts', 'lookup.ts'),
        'const input = JSON.parse(await Bun.stdin.text()); if (input.payload !== process.env.REVIEW_INHERITED_SECRET) process.exit(3); console.error("expected failure"); process.exit(2);'
      );
      mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
        actualInput = { ...args, payload: secret, items: [{ id: 7, [secret]: secret }] };
        try {
          await options?.nativeTools?.[0].handler(actualInput);
        } catch (cause) {
          error = cause;
        }
        yield reply();
      });
      await run([agent(writes)]);
      expect(actualInput).toEqual({
        ...args,
        payload: secret,
        items: [{ id: 7, [secret]: secret }],
      });
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('expected failure');
      expect(events('script_tool_call')).toHaveLength(1);
      expect(events('script_tool_call')[0]?.data).toMatchObject({
        status: 'failed',
        input: {
          ...args,
          payload: '[REDACTED]',
          items: [{ id: 7, '[REDACTED]': '[REDACTED]' }],
        },
      });
      expect(JSON.stringify(events('script_tool_call'))).not.toContain(secret);
      expect(events('node_failed')).toHaveLength(0);
      expect(events('node_completed')).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
);

test.each(['preparation', 'call', 'swallowed'] as const)(
  'unreadable captured tool source releases the run during %s',
  async phase => {
    const capture = await captureWorkflowSource({
      sourceRoot: root,
      captureRoot: join(root, 'capture'),
    });
    let invoking = false;
    let handlerError: unknown;
    let handlerCalls = 0;
    const readFile = fs.readFile;
    const checkSource = sourceLoader.assertWorkflowSourceIntegrity;
    const fault = spyOn(sourceLoader, 'assertWorkflowSourceIntegrity').mockImplementation(
      async (...parameters) => {
        if (phase === 'preparation')
          throw new WorkflowSourceUnavailableError(join(root, 'capture'), new Error('read denied'));
        return checkSource(...parameters);
      }
    );
    const read = spyOn(fs, 'readFile').mockImplementation((async (
      path: Parameters<typeof fs.readFile>[0],
      options?: Parameters<typeof fs.readFile>[1]
    ) => {
      if (invoking && String(path).endsWith('lookup.ts'))
        throw Object.assign(new Error('read denied'), {
          code: 'EACCES',
          syscall: 'open',
          path: String(path),
        });
      return readFile(path, options);
    }) as typeof fs.readFile);
    const exec = spyOnNodeExec().mockResolvedValue({ stdout: '{"green":false}', stderr: '' });
    try {
      mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
        invoking = true;
        handlerCalls++;
        try {
          await options?.nativeTools?.[0].handler(args);
        } catch (cause) {
          handlerError = cause;
          if (phase !== 'swallowed') throw cause;
        }
        yield reply();
      });
      const outcome = await executeDagWorkflow(
        dagOptions({
          deps,
          platform: createMockPlatform(),
          cwd: root,
          workflowRun: makeWorkflowRun(),
          workflowProvider: 'claude',
          workflow: { name: 'tools', nodes: [agent()] },
          workflowSourceRoots: capturedSourceRoots(capture.anchor),
        })
      );
      expect(outcome).toEqual({ kind: 'source_release', released: true });
      expect(deps.store.releaseRunForUnreadableSource).toHaveBeenCalledTimes(1);
      expect(events('workflow_failed')).toHaveLength(0);
      expect(events('node_failed')).toHaveLength(1);
      expect(events('node_failed')[0]?.data?.error).toContain("could not read the run's source");
      expect(events('node_completed')).toHaveLength(0);
      expect(events('script_tool_call')).toHaveLength(0);
      expect(exec.mock.calls.filter(([command]) => command === 'bun')).toHaveLength(0);
      expect(handlerCalls).toBe(phase === 'preparation' ? 0 : 1);
      if (phase !== 'preparation') expect(handlerError).toBeInstanceOf(Error);
    } finally {
      fault.mockRestore();
      read.mockRestore();
      exec.mockRestore();
    }
  }
);

test('a failed call-event write takes precedence over overlapping source recovery', async () => {
  const persisting = Promise.withResolvers<void>();
  const sourceFailed = Promise.withResolvers<void>();
  const storageError = new Error('call event store unavailable');
  const persist = deps.store.persistWorkflowEvent.getMockImplementation();
  if (!persist) throw new Error('Missing persist implementation');
  deps.store.persistWorkflowEvent.mockImplementation(async event => {
    if (event.event_type === 'script_tool_call') {
      persisting.resolve();
      await sourceFailed.promise;
      throw storageError;
    }
    return persist(event);
  });
  const prepare = scriptExecution.prepareToolScript;
  let rechecks = 0;
  const source = spyOn(scriptExecution, 'prepareToolScript').mockImplementation(
    async (...parameters) => {
      const prepared = await prepare(...parameters);
      return {
        ...prepared,
        recheck: async () => {
          rechecks++;
          if (rechecks === 2) {
            sourceFailed.resolve();
            throw new RunSourceUnreadableError(
              'inspect',
              new WorkflowSourceUnavailableError(join(root, 'capture'), new Error('read denied'))
            );
          }
          return prepared.recheck();
        },
      };
    }
  );
  try {
    mockSendQueryDag.mockImplementation(async function* (_p, _c, _r, options) {
      const tool = options?.nativeTools?.[0];
      if (!tool) throw new Error('Missing tool');
      const writing = tool.handler(args);
      void writing.catch(() => undefined);
      await persisting.promise;
      const reading = tool.handler(args);
      await Promise.allSettled([writing, reading]);
      yield reply();
    });
    await expect(run([agent(true)])).rejects.toThrow('call event store unavailable');
    expect(rechecks).toBe(2);
    expect(deps.store.releaseRunForUnreadableSource).not.toHaveBeenCalled();
    expect(deps.store.pauseWorkflowRunForWait).not.toHaveBeenCalled();
    expect(events('node_completed')).toHaveLength(0);
  } finally {
    source.mockRestore();
  }
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
