// @archon-test-isolated
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { executeDagWorkflow } from '../../../dag-executor';
import { validateNodeOutputFormats } from '../../../loader/contracts';
import {
  parsePackagedResourceReference,
  qualifyWorkflowResources,
} from '../../../packaged-workflow';
import type { AgentNode } from '../../../schemas';
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

const SECRET = 'tool-secret-value-9f2c';
let root: string;
let deps: ReturnType<typeof createMockDeps<MockWorkflowStore>>;
const events = (type: string) =>
  persistedEvents(deps.store).filter(event => event.event_type === type);

const agent: AgentNode = {
  kind: 'agent',
  source: { kind: 'inline', prompt: 'Use lookup, then report' },
  id: 'inspect',
  tools: {
    lookup: {
      description: 'Look up the checks of a pull request',
      script: 'lookup',
      input_schema: {
        type: 'object',
        properties: { pr: { type: 'integer' }, note: { type: 'string' } },
        required: ['pr'],
        additionalProperties: false,
      },
      output_schema: {
        type: 'object',
        properties: { green: { type: 'boolean' } },
        required: ['green'],
      },
    },
  },
};

const writeLookup = (body: string) =>
  writeFile(join(root, '.archon', 'scripts', 'lookup.ts'), body);

/** Run the node with a provider that makes one tool call and then answers. */
async function runWithCall(
  input: Record<string, unknown>,
  provider = 'claude'
): Promise<{ returned?: string; error?: Error }> {
  const call: { returned?: string; error?: Error } = {};
  mockSendQueryDag.mockImplementation(async function* (_prompt, _cwd, _resume, options) {
    const tool = options?.nativeTools?.find(native => native.name === 'lookup');
    if (!tool) throw new Error('The declared tool was not offered');
    try {
      call.returned = await tool.handler(input, { providerCallId: 'call-7' });
    } catch (error) {
      call.error = error as Error;
    }
    yield { type: 'result' as const, text: 'Checks reported' };
  });
  await executeDagWorkflow(
    dagOptions({
      deps,
      platform: createMockPlatform(),
      cwd: root,
      workflowRun: makeWorkflowRun(),
      workflowProvider: provider,
      workflow: { name: 'tools', nodes: [agent] },
      config: { ...minimalConfig, protectedCredentialValues: [SECRET] },
    })
  );
  return call;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-script-tools-'));
  await mkdir(join(root, '.archon', 'scripts'), { recursive: true });
  await writeLookup(
    'const input = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({ green: input.pr === 7 }));'
  );
  deps = createMockDeps();
  mockSendQueryDag.mockClear();
});
afterEach(async () => {
  await removeTempTree(root);
});

test('a declared tool runs its script on the call input and returns the output to the agent', async () => {
  const call = await runWithCall({ pr: 7 });

  expect(call.returned).toBe('{"green":true}');
  expect(events('node_completed')).toHaveLength(1);
  const recorded = events('script_tool_call');
  expect(recorded).toHaveLength(1);
  expect(recorded[0].data).toMatchObject({
    tool_name: 'lookup',
    provider_call_id: 'call-7',
    status: 'completed',
    input: { pr: 7 },
    output: { green: true },
  });
});

test('input that does not match the schema starts no script and returns an error to the agent', async () => {
  const exec = spyOnNodeExec().mockResolvedValue({ stdout: '{"green":true}', stderr: '' });
  try {
    const call = await runWithCall({ pr: 'seven' });

    expect(call.error).toBeInstanceOf(Error);
    expect(exec.mock.calls.filter(([command]) => command === 'bun')).toHaveLength(0);
    expect(events('script_tool_call').map(event => event.data?.status)).toEqual(['failed']);
    expect(events('node_completed')).toHaveLength(1);
  } finally {
    exec.mockRestore();
  }
});

test.each([
  ['a script that exits non-zero', 'console.error("checks unavailable"); process.exit(2);'],
  ['output that does not match the schema', 'console.log(JSON.stringify({ green: "yes" }));'],
])('%s returns an error to the agent and the node goes on', async (_name, body) => {
  await writeLookup(body);

  const call = await runWithCall({ pr: 7 });

  expect(call.error).toBeInstanceOf(Error);
  expect(events('script_tool_call').map(event => event.data?.status)).toEqual(['failed']);
  expect(events('node_failed')).toHaveLength(0);
  expect(events('node_completed')).toHaveLength(1);
});

test.each([
  ['a completed', `console.log(JSON.stringify({ green: true, ${JSON.stringify(SECRET)}: 1 }));`],
  ['a failed', `console.error("denied for ${SECRET}"); process.exit(2);`],
  ['an invalid-input', undefined],
])('%s call is recorded without a credential value', async (_name, body) => {
  if (body) await writeLookup(body);

  await runWithCall(body ? { pr: 7, note: `token ${SECRET}` } : { pr: SECRET });

  const recorded = events('script_tool_call');
  expect(recorded).toHaveLength(1);
  expect(JSON.stringify(recorded[0].data)).not.toContain(SECRET);
});

test('a node on a provider that cannot offer tools is refused before any model call', async () => {
  await expect(runWithCall({ pr: 7 }, 'opencode')).rejects.toThrow();
  expect(mockSendQueryDag).not.toHaveBeenCalled();
});

test('a tool whose script does not exist fails the node before any model call', async () => {
  await removeTempTree(join(root, '.archon', 'scripts', 'lookup.ts'));

  await runWithCall({ pr: 7 });

  expect(mockSendQueryDag).not.toHaveBeenCalled();
  expect(events('node_failed')).toHaveLength(1);
});

test.each([
  ['an input schema that is not an object', { input_schema: { type: 'string' } }],
  ['a schema that cannot be compiled', { output_schema: { $ref: '#/missing' } }],
])('%s fails the workflow at load', (_name, override) => {
  const lookup = { ...agent.tools?.lookup, ...override };

  expect(validateNodeOutputFormats([{ ...agent, tools: { lookup } } as AgentNode])).not.toBeNull();
});

test("a pack workflow's tool resolves its script inside the pack", () => {
  const workflow = { name: 'inspect', description: 'tools', nodes: [structuredClone(agent)] };

  qualifyWorkflowResources(workflow, { source: 'project', pack: 'checks', workflow: 'inspect' });

  const script = workflow.nodes[0].tools?.lookup.script ?? '';
  expect(parsePackagedResourceReference(script)).not.toBeNull();
});
