// @archon-test-isolated
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import type { SendQueryOptions } from '@archon/provider-contract';
import { buildArchonMcpServer } from '../../../../../providers/src/claude/native-tools';
import { recordNodeProcessTrees } from '../../../subprocess';
import * as subprocess from '../../../subprocess';
import { spyOn } from 'bun:test';
import { executeDagWorkflow } from '../../../dag-executor';
import { dagNodeSchema } from '../../../schemas';
import { formatPackagedResourceReference } from '../../../packaged-workflow';
import { toolCallRef, toolValueDigest, writeToolCallValue } from '../../../tool-calls';
import type { AgentNode, DagNode, ExecNode } from '../../../schemas';
import {
  createMockDeps,
  createMockStore,
  dagOptions,
  makeWorkflowRun,
  mockCodexCapabilities,
  mockSendQueryDag,
  persistedEvents,
} from '../../test-utils';

const tools: AgentNode['tools'] = {
  record: {
    description: 'Record one value',
    input_schema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    output_schema: {
      type: 'object',
      properties: {
        value: { type: 'string' },
        callId: { type: 'string' },
      },
      required: ['value', 'callId'],
      additionalProperties: false,
    },
    script: 'record',
    timeout: 5_000,
  },
};

function agent(provider = 'codex'): AgentNode {
  return {
    id: 'actor',
    kind: 'agent',
    provider,
    source: { kind: 'inline', prompt: 'record' },
    tools,
  };
}

const consumer: ExecNode = {
  id: 'consumer',
  kind: 'exec',
  runtime: 'bun',
  depends_on: ['actor'],
  output_format: {
    type: 'object',
    properties: { value: { type: 'string' }, callId: { type: 'string' } },
    required: ['value', 'callId'],
    additionalProperties: false,
  },
  script: `
    const listing = JSON.parse(await Bun.file(process.env.TOOL_CALLS_FILE!).text());
    const call = listing.calls.find((entry) => entry.status === 'completed');
    const output = JSON.parse(await Bun.file(\`\${process.env.ARTIFACTS_DIR}/\${call.output_ref}\`).text());
    console.log(JSON.stringify(output));
  `,
};

describe('workflow script tools', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `script-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(testDir, '.archon', 'scripts'), { recursive: true });
    mockSendQueryDag.mockClear();
  });

  afterEach(async () => {
    delete process.env.COUNT_FILE;
    delete process.env.TOOL_SECRET;
    await removeTempTree(testDir);
  });

  async function run(nodes: DagNode[], provider = 'codex') {
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflowProvider: provider,
        workflow: { name: 'script-tools', nodes },
        workflowRun: makeWorkflowRun('script-tools-run'),
      })
    );
    return store;
  }

  it('parses the tool declaration into an agent node', () => {
    expect(dagNodeSchema.parse({ id: 'actor', prompt: 'record', tools })).toMatchObject({
      kind: 'agent',
      tools,
    });
    expect(() =>
      dagNodeSchema.parse({
        id: 'actor',
        prompt: 'record',
        tools: { record: { ...tools!.record, script: 'merge gate' } },
      })
    ).toThrow('named script');
  });

  it.each(['codex', 'claude', 'pi'] as const)(
    'executes a named script once and exposes its exact receipt to a later script: %s',
    async provider => {
      await writeFile(
        join(testDir, '.archon', 'scripts', 'record.ts'),
        `
        const count = Number(await Bun.file(process.env.COUNT_FILE!).text().catch(() => '0'));
        await Bun.write(process.env.COUNT_FILE!, String(count + 1));
        const input = JSON.parse(process.env.ARCHON_TOOL_INPUT!);
        console.log(JSON.stringify({ value: input.value, callId: process.env.ARCHON_TOOL_CALL_ID }));
      `
      );
      process.env.COUNT_FILE = join(testDir, 'count');
      let options: SendQueryOptions | undefined;
      mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, queryOptions) {
        options = queryOptions;
        const tool = queryOptions?.nativeTools?.[0];
        if (!tool) throw new Error('script tool was not offered');
        const [first, second] = await Promise.all([
          tool.handler({ value: 'hello' }, { providerCallId: `${provider}-call-1` }),
          tool.handler({ value: 'hello' }, { providerCallId: `${provider}-call-1` }),
        ]);
        expect(second).toBe(first);
        yield { type: 'agent_message_chunk', text: first };
        yield { type: 'result', sessionId: 'codex-session' };
      });

      const store = await run([agent(provider), consumer], provider);
      expect(await readFile(process.env.COUNT_FILE!, 'utf8')).toBe('1');
      const receipts = persistedEvents(store).filter(
        event => event.event_type === 'workflow_tool_call'
      );
      expect(receipts.map(event => event.data?.status)).toEqual(['started', 'completed']);
      expect(receipts[1]?.data).toMatchObject({
        provider_call_id: `${provider}-call-1`,
        tool_name: 'record',
        run_id: 'script-tools-run',
      });
      const completed = persistedEvents(store).find(
        event => event.event_type === 'node_completed' && event.step_name === 'consumer'
      );
      expect(completed?.data?.structured_output).toMatchObject({ value: 'hello' });
      expect(options?.nodeConfig?.mcp).toBeUndefined();
      expect(options?.nodeConfig?.skills).toBeUndefined();
      expect(options?.nodeConfig?.plugins).toBeUndefined();
    }
  );

  it('rejects invalid input before writing a receipt or starting the script', async () => {
    const effect = join(testDir, 'invalid-input-effect');
    await writeFile(
      join(testDir, '.archon', 'scripts', 'record.ts'),
      `await Bun.write(${JSON.stringify(effect)}, 'yes'); console.log('{}')`
    );
    let rejection: unknown;
    let started = -1;
    mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, queryOptions) {
      const tool = queryOptions?.nativeTools?.[0];
      if (!tool) throw new Error('script tool was not offered');
      rejection = await tool.handler({}, { providerCallId: 'bad-input' }).catch(error => error);
      started = persistedEvents(store).filter(
        event => event.event_type === 'workflow_tool_call'
      ).length;
      yield { type: 'agent_message_chunk', text: 'refused' };
      yield { type: 'result', sessionId: 'codex-session' };
    });
    const store = createMockStore();
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflowProvider: 'codex',
        workflow: { name: 'script-tools-invalid', nodes: [agent()] },
        workflowRun: makeWorkflowRun('script-tools-invalid-run'),
      })
    );
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain('before script start');
    expect(started).toBe(0);
    expect(await Bun.file(effect).exists()).toBe(false);
  });

  it('replays a completed receipt instead of repeating the script on a later attempt', async () => {
    await writeFile(
      join(testDir, '.archon', 'scripts', 'record.ts'),
      `
        const count = Number(await Bun.file(process.env.COUNT_FILE!).text().catch(() => '0'));
        await Bun.write(process.env.COUNT_FILE!, String(count + 1));
        console.log(JSON.stringify({ value: 'once', callId: process.env.ARCHON_TOOL_CALL_ID }));
      `
    );
    process.env.COUNT_FILE = join(testDir, 'count');
    let attempts = 0;
    mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, queryOptions) {
      attempts++;
      const output = await queryOptions?.nativeTools?.[0]?.handler(
        { value: 'once' },
        { providerCallId: 'replayed-call' }
      );
      if (attempts === 1) throw new Error('lost provider observation');
      yield { type: 'agent_message_chunk', text: output ?? '' };
      yield { type: 'result', sessionId: 'codex-session' };
    });
    const store = await run([
      { ...agent(), retry: { max_attempts: 1, delay_ms: 1000, on_error: 'all' } },
    ]);
    expect(await readFile(process.env.COUNT_FILE!, 'utf8')).toBe('1');
    expect(
      persistedEvents(store)
        .filter(event => event.event_type === 'workflow_tool_call')
        .map(event => event.data?.status)
    ).toEqual(['started', 'completed']);
    expect(
      persistedEvents(store).some(
        event => event.event_type === 'node_completed' && event.step_name === 'actor'
      )
    ).toBe(true);
  });

  it.each([
    { label: 'non-JSON', source: `console.log('not-json')` },
    { label: 'schema-mismatch', source: `console.log(JSON.stringify({ value: 42 }))` },
  ])('records unknown output without exposing it as a success: $label', async ({ source }) => {
    await writeFile(join(testDir, '.archon', 'scripts', 'record.ts'), source);
    mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, queryOptions) {
      const tool = queryOptions?.nativeTools?.[0];
      if (!tool) throw new Error('script tool was not offered');
      await expect(
        tool.handler({ value: 'hello' }, { providerCallId: 'bad-output' })
      ).rejects.toThrow();
      yield { type: 'agent_message_chunk', text: 'tool failed' };
      yield { type: 'result', sessionId: 'codex-session' };
    });
    const store = await run([agent()]);
    const receipts = persistedEvents(store).filter(
      event => event.event_type === 'workflow_tool_call'
    );
    expect(receipts.map(event => event.data?.status)).toEqual(['started', 'outcome_unknown']);
    expect(receipts[1]?.data).not.toHaveProperty('output_ref');
  });

  it.each([
    { label: 'non-JSON', suffix: "console.log('bad-json')" },
    { label: 'nonzero exit', suffix: 'process.exit(2)' },
    { label: 'signal kill', suffix: `process.kill(process.pid, 'SIGKILL')` },
  ])('does not retry a side effect after $label', async ({ suffix }) => {
    const countPath = join(testDir, 'effect-count');
    await writeFile(
      join(testDir, '.archon', 'scripts', 'record.ts'),
      `
      const count = Number(await Bun.file(${JSON.stringify(countPath)}).text().catch(() => '0'));
      await Bun.write(${JSON.stringify(countPath)}, String(count + 1));
      ${suffix}
    `
    );
    let attempts = 0;
    mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, queryOptions) {
      attempts++;
      await expect(
        queryOptions!.nativeTools![0].handler(
          { value: 'x' },
          { providerCallId: `call-${attempts}` }
        )
      ).rejects.toThrow();
      throw new Error('provider observation lost');
      yield { type: 'result', sessionId: 'unreachable' };
    });
    const store = await run([
      { ...agent(), retry: { max_attempts: 1, delay_ms: 1, on_error: 'all' } },
    ]);
    expect(attempts).toBe(1);
    expect(await readFile(countPath, 'utf8')).toBe('1');
    expect(
      persistedEvents(store)
        .filter(event => event.event_type === 'workflow_tool_call')
        .map(event => event.data?.status)
    ).toEqual(['started', 'outcome_unknown']);
  });

  it('refuses modified completed output before a later consumer runs', async () => {
    await writeFile(
      join(testDir, '.archon', 'scripts', 'record.ts'),
      `console.log(JSON.stringify({ value: 'real', callId: process.env.ARCHON_TOOL_CALL_ID }))`
    );
    const store = createMockStore();
    mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, queryOptions) {
      await queryOptions!.nativeTools![0].handler({ value: 'x' }, { providerCallId: 'original' });
      const receipt = persistedEvents(store).find(
        event => event.event_type === 'workflow_tool_call' && event.data?.status === 'completed'
      );
      await writeFile(
        join(testDir, 'artifacts', String(receipt!.data!.output_ref)),
        JSON.stringify({ value: 'forged', callId: 'forged' })
      );
      yield { type: 'agent_message_chunk', text: 'done' };
      yield { type: 'result', sessionId: 'session' };
    });
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflowProvider: 'codex',
        workflowRun: makeWorkflowRun('tampered-run'),
        workflow: { name: 'tampered', nodes: [agent(), consumer] },
      })
    );
    expect(
      persistedEvents(store).some(
        event => event.event_type === 'node_completed' && event.step_name === 'consumer'
      )
    ).toBe(false);
    expect(persistedEvents(store).some(event => event.event_type === 'node_failed')).toBe(true);
  });

  it('does not run a new provider call after an earlier attempt completed a write', async () => {
    const countPath = join(testDir, 'completed-count');
    await writeFile(
      join(testDir, '.archon', 'scripts', 'record.ts'),
      `
      const count = Number(await Bun.file(${JSON.stringify(countPath)}).text().catch(() => '0'));
      await Bun.write(${JSON.stringify(countPath)}, String(count + 1));
      console.log(JSON.stringify({ value: 'once', callId: process.env.ARCHON_TOOL_CALL_ID }));
    `
    );
    let attempts = 0;
    mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, queryOptions) {
      attempts++;
      if (attempts === 1) {
        await queryOptions!.nativeTools![0].handler({ value: 'x' }, { providerCallId: 'first' });
        throw new Error('provider observation lost');
      }
      await expect(
        queryOptions!.nativeTools![0].handler({ value: 'x' }, { providerCallId: 'different' })
      ).rejects.toThrow('cannot safely replay');
      yield { type: 'agent_message_chunk', text: 'refused' };
      yield { type: 'result', sessionId: 'session' };
    });
    const store = await run([
      { ...agent(), retry: { max_attempts: 2, delay_ms: 1, on_error: 'all' } },
    ]);
    expect(attempts).toBe(2);
    expect(await readFile(countPath, 'utf8')).toBe('1');
    expect(
      persistedEvents(store)
        .filter(event => event.event_type === 'workflow_tool_call')
        .map(event => event.data?.status)
    ).toEqual(['started', 'completed']);
    expect(
      persistedEvents(store).some(
        event => event.event_type === 'node_completed' && event.step_name === 'actor'
      )
    ).toBe(false);
  });

  it('blocks a concurrent tool that was still preparing when another outcome became unknown', async () => {
    await writeFile(join(testDir, '.archon', 'scripts', 'record.ts'), 'console.log("{}")');
    const store = createMockStore();
    const release = Promise.withResolvers<void>();
    let first = true;
    store.persistWorkflowEvent.mockImplementation(async event => {
      if (event.event_type === 'workflow_tool_call' && event.data?.status === 'started') {
        if (first) {
          first = false;
          await store.createWorkflowEvent(event);
          return;
        }
        await release.promise;
      }
      await store.createWorkflowEvent(event);
    });
    let spawned = 0;
    const spy = spyOn(subprocess, 'runSubprocess').mockImplementation(async () => {
      spawned++;
      throw Object.assign(new Error('tree survived'), { treeSurvived: true, timedOut: true });
    });
    try {
      mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, queryOptions) {
        const tool = queryOptions!.nativeTools![0];
        const firstCall = tool.handler({ value: 'a' }, { providerCallId: 'a' });
        const secondCall = tool.handler({ value: 'b' }, { providerCallId: 'b' });
        const firstRejected = firstCall.catch(error => error);
        const secondRejected = secondCall.catch(error => error);
        expect((await firstRejected).message).toBe('tree survived');
        release.resolve();
        expect((await secondRejected).message).toContain('unknown outcome');
        yield { type: 'agent_message_chunk', text: 'refused' };
        yield { type: 'result', sessionId: 'session' };
      });
      await executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(store),
          cwd: testDir,
          workflowProvider: 'codex',
          workflowRun: makeWorkflowRun('concurrent'),
          workflow: { name: 'concurrent', nodes: [agent()] },
        })
      );
      expect(spawned).toBe(1);
      expect(
        persistedEvents(store).some(
          event =>
            event.event_type === 'workflow_tool_call' && event.data?.status === 'outcome_unknown'
        )
      ).toBe(true);
    } finally {
      release.resolve();
      spy.mockRestore();
    }
  });

  it('refuses provider-sandboxed tools before a model call', async () => {
    const sandbox = { enabled: true, filesystem: { denyWrite: [testDir] } };
    await expect(run([{ ...agent('claude'), sandbox }], 'claude')).rejects.toThrow(
      'provider sandbox'
    );
    expect(mockSendQueryDag).not.toHaveBeenCalled();
  });

  it('refuses container-backed script tools before a model call', async () => {
    await expect(
      executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          cwd: testDir,
          execContext: { kind: 'container', containerId: 'tool-container' },
          workflowProvider: 'claude',
          workflowRun: makeWorkflowRun('container-tools'),
          workflow: { name: 'container-tools', nodes: [agent('claude')] },
        })
      )
    ).rejects.toThrow('cannot run in a container');
    expect(mockSendQueryDag).not.toHaveBeenCalled();
  });

  it('refuses inherited workflow sandbox before a model call', async () => {
    await expect(
      executeDagWorkflow(
        dagOptions({
          deps: createMockDeps(),
          cwd: testDir,
          workflowProvider: 'claude',
          workflowRun: makeWorkflowRun('sandbox-default'),
          workflow: {
            name: 'sandbox-default',
            sandbox: { enabled: true },
            nodes: [agent('claude')],
          },
        })
      )
    ).rejects.toThrow('provider sandbox');
    expect(mockSendQueryDag).not.toHaveBeenCalled();
  });

  it('ends a script tool when its agent aborts while the run remains running', async () => {
    const startedPath = join(testDir, 'tool-started');
    const effectPath = join(testDir, 'after-abort');
    await writeFile(
      join(testDir, '.archon', 'scripts', 'record.ts'),
      `await Bun.write(${JSON.stringify(startedPath)}, 'yes'); await new Promise(resolve => setTimeout(resolve, 1000)); await Bun.write(${JSON.stringify(effectPath)}, 'yes'); console.log('{}')`
    );
    const controller = new AbortController();
    const trees = recordNodeProcessTrees();
    try {
      const { runSubprocessUntilRunStops } = await import('../../run-control');
      const pending = runSubprocessUntilRunStops(
        createMockStore(),
        'abort-run',
        'actor',
        { kind: 'host' },
        'bun',
        ['--no-env-file', 'run', join(testDir, '.archon', 'scripts', 'record.ts')],
        {
          cwd: testDir,
          env: {},
          abortSignal: controller.signal,
          timeout: 2000,
          endTreeOnTimeout: true,
          retention: { standalone: true },
        }
      );
      while (!(await Bun.file(startedPath).exists()))
        await new Promise(resolve => setTimeout(resolve, 5));
      controller.abort();
      await expect(pending).rejects.toThrow();
      expect(await Bun.file(effectPath).exists()).toBe(false);
    } finally {
      trees.release();
    }
  });

  it('drains a running tool before recording a failed provider attempt', async () => {
    await writeFile(join(testDir, '.archon', 'scripts', 'record.ts'), 'console.log("{}")');
    const entered = Promise.withResolvers<void>();
    let stopped = false;
    const spy = spyOn(subprocess, 'runSubprocess').mockImplementation(
      async (_context, _command, _args, options) => {
        entered.resolve();
        await new Promise<void>(resolve =>
          options.abortSignal!.addEventListener(
            'abort',
            () => {
              stopped = true;
              resolve();
            },
            { once: true }
          )
        );
        throw Object.assign(new Error('cancelled tool'), { cancelled: true });
      }
    );
    try {
      mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, queryOptions) {
        void queryOptions!
          .nativeTools![0].handler({ value: 'x' }, { providerCallId: 'pending' })
          .catch(() => undefined);
        await entered.promise;
        throw new Error('provider stopped');
        yield { type: 'result', sessionId: 'unreachable' };
      });
      const store = await run([agent()]);
      expect(stopped).toBe(true);
      const events = persistedEvents(store);
      const unknown = events.findIndex(
        event =>
          event.event_type === 'workflow_tool_call' && event.data?.status === 'outcome_unknown'
      );
      expect(unknown).toBeGreaterThan(-1);
      expect(
        events.findIndex(event => event.event_type === 'node_failed' && event.step_name === 'actor')
      ).toBeGreaterThan(unknown);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps an unsettled provider failure non-retryable after aborting a running tool', async () => {
    await writeFile(join(testDir, '.archon', 'scripts', 'record.ts'), 'console.log("{}")');
    const entered = Promise.withResolvers<void>();
    let aborted = false;
    const spy = spyOn(subprocess, 'runSubprocess').mockImplementation(
      async (_context, _command, _args, options) => {
        entered.resolve();
        await new Promise<void>(resolve =>
          options.abortSignal!.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve();
            },
            { once: true }
          )
        );
        throw Object.assign(new Error('cancelled tool'), { cancelled: true });
      }
    );
    try {
      mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, queryOptions) {
        void queryOptions!
          .nativeTools![0].handler({ value: 'x' }, { providerCallId: 'unsettled-call' })
          .catch(() => undefined);
        await entered.promise;
        yield { type: 'agent_message_chunk', text: 'partial text' };
      });
      const store = createMockStore();
      const deps = createMockDeps(store);
      deps.getAgentProvider = () => ({
        sendQuery: mockSendQueryDag,
        checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
        getType: () => 'codex',
        getCapabilities: mockCodexCapabilities,
      });
      await executeDagWorkflow(
        dagOptions({
          deps,
          cwd: testDir,
          workflowProvider: 'codex',
          workflowRun: makeWorkflowRun('unsettled-tools'),
          workflow: {
            name: 'unsettled-tools',
            nodes: [{ ...agent(), retry: { max_attempts: 2, delay_ms: 1, on_error: 'all' } }],
          },
        })
      );
      expect(aborted).toBe(true);
      const events = persistedEvents(store);
      const failure = events.find(
        event => event.event_type === 'node_failed' && event.step_name === 'actor'
      )?.data;
      expect(failure?.error).toContain('provider stream ended without signalling');
      expect(failure).toMatchObject({ failure_kind: 'unknown', retryable: false });
      expect(
        events.filter(event => event.event_type === 'node_started' && event.step_name === 'actor')
      ).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('scopes Claude MCP request IDs to each server and loop invocation', async () => {
    const countPath = join(testDir, 'loop-count');
    await writeFile(
      join(testDir, '.archon', 'scripts', 'record.ts'),
      `
      const count = Number(await Bun.file(${JSON.stringify(countPath)}).text().catch(() => '0'));
      await Bun.write(${JSON.stringify(countPath)}, String(count + 1));
      console.log(JSON.stringify({ value: String(count + 1), callId: process.env.ARCHON_TOOL_CALL_ID }));
    `
    );
    let turns = 0;
    mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, queryOptions) {
      turns++;
      const server = buildArchonMcpServer(queryOptions!.nativeTools!);
      const response = Promise.withResolvers<unknown>();
      const transport: Parameters<typeof server.instance.connect>[0] = {
        start: async () => {},
        close: async () => {},
        send: async message => {
          if ('id' in message) response.resolve(message);
        },
      };
      await server.instance.connect(transport);
      try {
        transport.onmessage?.({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'record', arguments: { value: 'same' } },
        });
        await response.promise;
      } finally {
        await server.instance.close();
      }
      yield { type: 'agent_message_chunk', text: turns === 2 ? 'DONE' : 'first' };
      yield { type: 'result', sessionId: `session-${turns}` };
    });
    const store = await run(
      [
        {
          id: 'rounds',
          kind: 'loop_group',
          loop_group: {
            max_iterations: 2,
            fresh_context: true,
            until: 'DONE',
            nodes: [agent('claude')],
          },
        },
      ],
      'claude'
    );
    expect(turns).toBe(2);
    expect(await readFile(countPath, 'utf8')).toBe('2');
    const receipts = persistedEvents(store).filter(
      event => event.event_type === 'workflow_tool_call' && event.data?.status === 'completed'
    );
    expect(new Set(receipts.map(event => event.data?.provider_call_scope)).size).toBe(2);
    expect(new Set(receipts.map(event => event.data?.invocation_id)).size).toBe(2);
  });

  it('executes a pack-local tool script instead of a shared script with the same name', async () => {
    await mkdir(join(testDir, '.archon', 'workflows', 'kit', 'act', 'scripts'), {
      recursive: true,
    });
    await writeFile(
      join(testDir, '.archon', 'workflows', 'kit', 'act', 'scripts', 'record.ts'),
      `console.log(JSON.stringify({ value: 'pack', callId: process.env.ARCHON_TOOL_CALL_ID }))`
    );
    await writeFile(
      join(testDir, '.archon', 'scripts', 'record.ts'),
      `console.log(JSON.stringify({ value: 'shared', callId: process.env.ARCHON_TOOL_CALL_ID }))`
    );
    const packed = { ...agent(), tools: { record: { ...tools!.record } } };
    packed.tools!.record.script = formatPackagedResourceReference(
      { source: 'project', pack: 'kit', workflow: 'act' },
      'record'
    );
    let returned = '';
    mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, queryOptions) {
      returned = await queryOptions!.nativeTools![0].handler(
        { value: 'x' },
        { providerCallId: 'pack-call' }
      );
      yield { type: 'agent_message_chunk', text: 'done' };
      yield { type: 'result', sessionId: 'session' };
    });
    await run([packed]);
    expect(JSON.parse(returned)).toMatchObject({ value: 'pack' });
  });

  it('fails non-retryably when a retry sees a started receipt', async () => {
    const callId = '00000000-0000-4000-8000-000000000001';
    const inputRef = toolCallRef(callId, 'input.json');
    await writeToolCallValue(join(testDir, 'artifacts'), inputRef, { value: 'x' });
    const store = createMockStore();
    await store.createWorkflowEvent({
      workflow_run_id: 'script-tools-run',
      event_type: 'workflow_tool_call',
      step_name: 'actor',
      data: {
        call_id: callId,
        run_id: 'script-tools-run',
        node_id: 'actor',
        attempt_id: 'previous-attempt',
        tool_name: 'record',
        provider_call_id: 'pending-call',
        input_ref: inputRef,
        input_digest: toolValueDigest(JSON.stringify({ value: 'x' })),
        status: 'started',
        recorded_at: new Date().toISOString(),
      },
    });
    await writeFile(
      join(testDir, '.archon', 'scripts', 'record.ts'),
      `await Bun.write(${JSON.stringify(join(testDir, 'replayed-effect'))}, 'yes')`
    );
    let rejection: unknown;
    mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, queryOptions) {
      rejection = await queryOptions!
        .nativeTools![0].handler({ value: 'x' }, { providerCallId: 'pending-call' })
        .catch(error => error);
      yield { type: 'agent_message_chunk', text: 'refused' };
      yield { type: 'result', sessionId: 'session' };
    });
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflowProvider: 'codex',
        workflowRun: makeWorkflowRun('script-tools-run'),
        workflow: {
          name: 'started-receipt',
          nodes: [{ ...agent(), retry: { max_attempts: 2, delay_ms: 1, on_error: 'all' } }],
        },
      })
    );
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain('no safe result to replay');
    expect(await Bun.file(join(testDir, 'replayed-effect')).exists()).toBe(false);
    const events = persistedEvents(store);
    expect(
      events.filter(event => event.event_type === 'node_started' && event.step_name === 'actor')
    ).toHaveLength(1);
    expect(
      events.find(event => event.event_type === 'node_failed' && event.step_name === 'actor')?.data
    ).toMatchObject({
      retryable: false,
    });
  });

  it.each([
    {
      label: 'timeout',
      source: `await new Promise(resolve => setTimeout(resolve, 1000)); console.log('{}')`,
      timeout: 50,
    },
    {
      label: 'output-limit',
      source: `console.log('x'.repeat(1024 * 1024 + 100))`,
      timeout: 5_000,
    },
  ])('marks $label outcome unknown and never retries it', async ({ source, timeout }) => {
    await writeFile(join(testDir, '.archon', 'scripts', 'record.ts'), source);
    mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, queryOptions) {
      const tool = queryOptions?.nativeTools?.[0];
      if (!tool) throw new Error('script tool was not offered');
      await expect(
        tool.handler({ value: 'hello' }, { providerCallId: 'uncertain' })
      ).rejects.toThrow();
      yield { type: 'agent_message_chunk', text: 'uncertain' };
      yield { type: 'result', sessionId: 'codex-session' };
    });
    const store = await run([
      {
        ...agent(),
        tools: { record: { ...tools!.record, timeout } },
        retry: { max_attempts: 2, delay_ms: 1000, on_error: 'all' },
      },
    ]);
    const events = persistedEvents(store);
    expect(
      events
        .filter(event => event.event_type === 'workflow_tool_call')
        .map(event => event.data?.status)
    ).toEqual(['started', 'outcome_unknown']);
    expect(
      events.filter(event => event.event_type === 'node_started' && event.step_name === 'actor')
    ).toHaveLength(1);
    expect(
      events.find(event => event.event_type === 'node_failed' && event.step_name === 'actor')?.data
    ).toMatchObject({
      retryable: false,
      failure_kind: 'exec_failed',
    });
  });

  it('marks a cancelled tool outcome unknown and does not retry it', async () => {
    await writeFile(join(testDir, '.archon', 'scripts', 'record.ts'), 'console.log("{}")');
    const spy = spyOn(subprocess, 'runSubprocess').mockImplementation(async () => {
      throw Object.assign(new Error('tool cancelled'), { cancelled: true });
    });
    let rejection: unknown;
    try {
      mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, queryOptions) {
        rejection = await queryOptions!
          .nativeTools![0].handler({ value: 'x' }, { providerCallId: 'cancelled-call' })
          .catch(error => error);
        yield { type: 'agent_message_chunk', text: 'cancelled' };
        yield { type: 'result', sessionId: 'session' };
      });
      const store = await run([
        { ...agent(), retry: { max_attempts: 2, delay_ms: 1, on_error: 'all' } },
      ]);
      expect(rejection).toBeInstanceOf(Error);
      const events = persistedEvents(store);
      expect(
        events
          .filter(event => event.event_type === 'workflow_tool_call')
          .map(event => event.data?.status)
      ).toEqual(['started', 'outcome_unknown']);
      expect(
        events.filter(event => event.event_type === 'node_started' && event.step_name === 'actor')
      ).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps empty output non-retryable when receipt persistence fails', async () => {
    const store = createMockStore();
    store.persistWorkflowEvent.mockImplementation(async event => {
      if (event.event_type === 'workflow_tool_call') throw new Error('receipt store unavailable');
      await store.createWorkflowEvent(event);
    });
    mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, queryOptions) {
      const tool = queryOptions?.nativeTools?.[0];
      if (!tool) throw new Error('script tool was not offered');
      await expect(
        tool.handler({ value: 'hello' }, { providerCallId: 'no-receipt' })
      ).rejects.toThrow('receipt store unavailable');
      yield { type: 'result', sessionId: 'codex-session' };
    });
    const nodes: DagNode[] = [
      { ...agent(), retry: { max_attempts: 2, delay_ms: 1, on_error: 'all' } },
    ];
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflowProvider: 'codex',
        workflow: { name: 'script-tools-no-receipt', nodes },
        workflowRun: makeWorkflowRun('script-tools-no-receipt-run'),
      })
    );
    const events = persistedEvents(store);
    const failure = events.find(
      event => event.event_type === 'node_failed' && event.step_name === 'actor'
    )?.data;
    expect(failure?.error).toContain('produced no assistant output');
    expect(failure).toMatchObject({ retryable: false, failure_kind: 'transient' });
    expect(
      events.filter(event => event.event_type === 'node_started' && event.step_name === 'actor')
    ).toHaveLength(1);
    expect(events.some(event => event.event_type === 'node_completed')).toBe(false);
  });

  it('refuses a provider without native tools before model invocation', async () => {
    await expect(run([{ ...agent(), provider: 'opencode' }])).rejects.toThrow(
      'provider cannot load what the node names'
    );
    expect(mockSendQueryDag).not.toHaveBeenCalled();
  });

  it('refuses a named script path escape without executing the target', async () => {
    const outside = join(testDir, 'outside.ts');
    await writeFile(outside, `await Bun.write('${join(testDir, 'escaped')}', 'yes')`);
    mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, queryOptions) {
      const tool = queryOptions?.nativeTools?.[0];
      if (!tool) throw new Error('script tool was not offered');
      await expect(tool.handler({ value: 'x' }, { providerCallId: 'escape' })).rejects.toThrow();
      yield { type: 'agent_message_chunk', text: 'refused' };
      yield { type: 'result', sessionId: 'codex-session' };
    });
    const store = await run([
      {
        ...agent(),
        tools: { record: { ...tools!.record, script: '../../outside' } },
      },
    ]);
    expect(await Bun.file(join(testDir, 'escaped')).exists()).toBe(false);
    expect(
      persistedEvents(store)
        .filter(event => event.event_type === 'workflow_tool_call')
        .map(event => event.data?.status)
    ).toEqual(['started', 'failed']);
  });

  it('redacts protected values before returning or persisting tool output', async () => {
    process.env.TOOL_SECRET = 'never-record-this';
    await writeFile(
      join(testDir, '.archon', 'scripts', 'record.ts'),
      `console.log(JSON.stringify({ value: process.env.TOOL_SECRET, callId: process.env.ARCHON_TOOL_CALL_ID }))`
    );
    let returned = '';
    mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, queryOptions) {
      const tool = queryOptions?.nativeTools?.[0];
      if (!tool) throw new Error('script tool was not offered');
      returned = await tool.handler({ value: 'x' }, { providerCallId: 'secret-output' });
      yield { type: 'agent_message_chunk', text: 'done' };
      yield { type: 'result', sessionId: 'codex-session' };
    });
    const store = createMockStore();
    const options = dagOptions({
      deps: createMockDeps(store),
      cwd: testDir,
      workflowProvider: 'codex',
      workflow: { name: 'script-tools-secret', nodes: [agent()] },
      workflowRun: makeWorkflowRun('script-tools-secret-run'),
    });
    options.config.protectedCredentialValues = ['never-record-this'];
    await executeDagWorkflow(options);
    expect(returned).not.toContain('never-record-this');
    const completed = persistedEvents(store).find(
      event => event.event_type === 'workflow_tool_call' && event.data?.status === 'completed'
    );
    const output = await readFile(
      join(testDir, 'artifacts', String(completed?.data?.output_ref)),
      'utf8'
    );
    expect(output).not.toContain('never-record-this');
  });
});
