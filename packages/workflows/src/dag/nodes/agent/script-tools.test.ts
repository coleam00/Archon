// @archon-test-isolated
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import type { SendQueryOptions } from '@archon/provider-contract';
import { executeDagWorkflow } from '../../../dag-executor';
import { dagNodeSchema } from '../../../schemas';
import type { AgentNode, DagNode, ExecNode } from '../../../schemas';
import {
  createMockDeps,
  createMockStore,
  dagOptions,
  makeWorkflowRun,
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
    let started = 0;
    mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _session, queryOptions) {
      const tool = queryOptions?.nativeTools?.[0];
      if (!tool) throw new Error('script tool was not offered');
      await expect(tool.handler({}, { providerCallId: 'bad-input' })).rejects.toThrow(
        'before script start'
      );
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
    expect(started).toBe(0);
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
  ])('records failed output without exposing it as a success: $label', async ({ source }) => {
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
    expect(receipts.map(event => event.data?.status)).toEqual(['started', 'failed']);
    expect(receipts[1]?.data).not.toHaveProperty('output_ref');
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

  it('fails closed when a receipt cannot be persisted', async () => {
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
      yield { type: 'agent_message_chunk', text: 'no receipt' };
      yield { type: 'result', sessionId: 'codex-session' };
    });
    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(store),
        cwd: testDir,
        workflowProvider: 'codex',
        workflow: { name: 'script-tools-no-receipt', nodes: [agent()] },
        workflowRun: makeWorkflowRun('script-tools-no-receipt-run'),
      })
    );
    expect(
      persistedEvents(store).find(
        event => event.event_type === 'node_failed' && event.step_name === 'actor'
      )?.data
    ).toMatchObject({ retryable: false, failure_kind: 'exec_failed' });
    expect(
      persistedEvents(store).some(
        event => event.event_type === 'node_completed' && event.step_name === 'actor'
      )
    ).toBe(false);
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
