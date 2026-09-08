import '../packages/workflows/src/defaults/text-imports.d.ts';
/** Native queue execution with scratch SQLite/Git; only model and forge transport are simulated. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { createWorkflowStore } from '@archon/core/workflows';
import { getOrCreateConversation } from '@archon/core/db/conversations';
import { closeDatabase } from '@archon/core/db/connection';
import { respondToWorkflow } from '@archon/core/operations/workflow-operations';
import { registerBuiltinProviders, getProviderCapabilities } from '@archon/providers';
import type { IAgentProvider } from '@archon/providers/types';
import { executeDagWorkflow } from '../packages/workflows/src/dag-executor';
import { discoverWorkflows } from '../packages/workflows/src/workflow-discovery';
import { resolveWorkflow } from '../packages/workflows/src/graph-plan';
import { liveSourceRoots } from '../packages/workflows/src/workflow-source';
import type { DagNode } from '../packages/workflows/src/schemas';
import type { WorkflowConfig } from '../packages/workflows/src/deps';

const [temporary, scenario] = process.argv.slice(2);
assert(temporary && scenario);
assert.equal(process.env.ARCHON_HOME, join(temporary, 'home'));
assert.equal(process.env.DATABASE_URL, '');
const repo = join(import.meta.dir, '..');
const script = join(repo, '.archon/workflows/sdlc/merge-queue/scripts/merge-queue.py');
const fixture = join(repo, 'packages/workflows/src/defaults/fixtures/merge-queue-scenario.py');
const cwd = join(temporary, 'queue');
const artifacts = join(temporary, 'artifacts');
const python = process.platform === 'win32' ? 'python' : 'python3';
async function run(argv: string[], directory = repo): Promise<string> {
  const child = Bun.spawn(argv, { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assert.equal(code, 0, stderr);
  return stdout.trim();
}
await run([python, fixture, script, temporary, scenario, 'setup']);
await mkdir(join(temporary, 'state'));
await mkdir(join(temporary, 'logs'));
const discovered = await discoverWorkflows(repo, { loadDefaults: false });
const original = discovered.workflows.find(
  entry => entry.workflow.name === 'archon-merge-queue'
)?.workflow;
assert(original);
// Install the forge process transport seam around the unmodified production script.
// Every binding, guard, include, loop, gate and other script remains authored code.
function transportSeam(node: DagNode): DagNode {
  if (node.kind === 'loop_group') {
    return {
      ...node,
      loop_group: {
        ...node.loop_group,
        nodes: node.loop_group.nodes.map(child => {
          assert('kind' in child && child.kind !== 'include');
          return transportSeam(child);
        }),
      },
    };
  }
  if (node.kind === 'exec' && node.script.endsWith(':merge-queue')) {
    return {
      ...node,
      script: `import sys, runpy\nsys.argv = ${JSON.stringify([fixture, script, temporary, scenario, 'node'])}\nrunpy.run_path(sys.argv[0], run_name='__main__')\n`,
    };
  }
  return node;
}
const { nodes: originalNodes, ...definition } = original;
const workflow = resolveWorkflow({ ...definition, nodes: originalNodes.map(transportSeam) });
const queueSchema = z.object({
  items: z.array(
    z.object({
      pr: z.object({ ref: z.object({ number: z.number() }) }),
      triage_started: z.boolean().optional(),
      triage: z.unknown().optional(),
      candidate: z.string().optional(),
      expected_base: z.string().optional(),
    })
  ),
  phase: z.string(),
  base_sha: z.string(),
  order_receipt: z.unknown(),
  candidate_receipt: z.unknown(),
});
async function queue(): Promise<z.infer<typeof queueSchema>> {
  return queueSchema.parse(JSON.parse(await readFile(join(artifacts, 'queue.json'), 'utf8')));
}
registerBuiltinProviders();
const provider: IAgentProvider = {
  getType: () => 'claude',
  getCapabilities: () => getProviderCapabilities('claude'),
  async *sendQuery(_prompt, _cwd, _resume, options) {
    const properties = z
      .record(z.string(), z.unknown())
      .parse(options?.outputFormat?.schema.properties ?? {});
    let output: unknown = 'Simulated independent model lens; no findings.';
    const state = await queue();
    if ('order' in properties) {
      if (scenario === 'auto_missing_assessment')
        throw new Error('Simulated model transport failure before diff assessment');
      output = {
        order: [1, 2],
        judgments: [1, 2].map(number => ({
          number,
          size: scenario === 'auto_changed_input' ? 'risky' : 'small_bounded',
          reason: 'Simulated independent diff assessment',
        })),
      };
    } else if ('contract' in properties) {
      const item = state.items.find(entry => entry.triage_started && !entry.triage);
      assert(item);
      assert.equal(await run(['git', 'rev-parse', 'HEAD'], cwd), state.base_sha);
      const number = item.pr.ref.number + 100;
      output = {
        route: 'deliver',
        summary: 'Simulated original work-item attribution',
        contract: 'READY',
        design_first: false,
        complexity: 'small_bounded',
        proposed_edits: { title: '', body: '' },
        labels: ['archon-ready'],
        blocked_by: [],
        blocked_reason: '',
        issue_repo: 'team/project',
        issue_number: number,
        issue_url: `https://github.com/team/project/issues/${String(number)}`,
      };
      await writeFile(
        join(artifacts, 'triage.md'),
        `Simulated fresh triage at ${state.base_sha}; original issue ${String(number)}`
      );
    } else if ('docs' in properties) {
      const head = await run(['git', 'rev-parse', 'HEAD'], cwd);
      const item = state.items.find(entry => entry.candidate === head);
      assert(item);
      await mkdir(join(artifacts, 'review'), { recursive: true });
      await writeFile(join(artifacts, 'review/scope.md'), `${item.expected_base}..${head}`);
      output = { docs: false };
    } else if ('ready' in properties) {
      await writeFile(
        join(artifacts, 'review/report.md'),
        'Simulated independent review of the exact local composition.'
      );
      output = {
        ready: scenario !== 'auto_failed_review',
        action: 'none',
        findings_summary: 'Simulated independent review',
      };
    } else if ('green' in properties) {
      const check = await run([python, 'check.py'], cwd);
      await writeFile(join(artifacts, 'validation.md'), `python check.py exited 0\n${check}`);
      output = { green: true, checks_performed: true, red_cause: '', summary: check };
    }
    yield {
      type: 'assistant',
      content: typeof output === 'string' ? output : JSON.stringify(output),
    };
    yield {
      type: 'result',
      sessionId: 'simulated-model',
      ...(typeof output === 'string' ? {} : { structuredOutput: output }),
    };
  },
};
const store = createWorkflowStore();
const conversation = await getOrCreateConversation('test', 'native-queue');
let workflowRun = await store.createWorkflowRun({
  workflow_name: workflow.name,
  conversation_id: conversation.id,
  working_path: cwd,
  user_message:
    'Two accepted bounded fixes await landing. The current release needs their composed result. Merge the exact reviewed chain, preserve a+b <= 2, and accept only green checks with unchanged identities.',
  metadata: {
    inputs: {
      prs: JSON.stringify(
        [1, 2].map(number => ({ repo: { host: 'example.test', path: 'team/project' }, number }))
      ),
    },
  },
});
await store.updateWorkflowRun(workflowRun.id, { status: 'running' });
workflowRun = { ...workflowRun, status: 'running' };
const config: WorkflowConfig = {
  assistant: 'claude',
  commands: {},
  assistants: { claude: {}, codex: {} },
  defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
};
const options = {
  deps: {
    store,
    getAgentProvider: (): IAgentProvider => provider,
    loadConfig: async (): Promise<WorkflowConfig> => config,
  },
  platform: {
    sendMessage: (): Promise<void> => Promise.resolve(),
    getStreamingMode: (): 'batch' => 'batch',
    getPlatformType: (): string => 'test',
  },
  conversationId: conversation.id,
  cwd,
  workflow,
  workflowProvider: 'claude',
  workflowModel: undefined,
  artifactsDir: artifacts,
  stateDir: join(temporary, 'state'),
  logDir: join(temporary, 'logs'),
  baseBranch: 'base',
  docsDir: 'docs',
  config,
  workflowSourceRoots: liveSourceRoots(repo),
};
const pauses: string[] = [];
try {
  for (let pass = 0; pass < 4; pass++) {
    const prior = await store.getDagResumeSnapshot(workflowRun.id);
    await executeDagWorkflow({
      ...options,
      workflowRun,
      priorCompletedNodes: prior.completedNodeOutputs,
    });
    const observed = await store.getWorkflowRun(workflowRun.id);
    assert(observed);
    if (observed.status !== 'paused') {
      assert.equal(
        observed.status,
        ['auto_changed_input', 'auto_missing_assessment'].includes(scenario)
          ? 'failed'
          : 'completed',
        JSON.stringify(observed.metadata)
      );
      if (scenario === 'auto_changed_input')
        assert(JSON.stringify(observed.metadata).includes('Intake is immutable on resume'));
      break;
    }
    const approval = z.object({ nodeId: z.string() }).parse(observed.metadata.approval);
    pauses.push(approval.nodeId);
    const snapshot = await readFile(join(artifacts, 'queue.json'), 'utf8');
    assert.equal(
      await run(['git', '--git-dir', join(temporary, 'remote.git'), 'rev-parse', 'base']),
      (await queue()).base_sha
    );
    await respondToWorkflow(
      workflowRun.id,
      scenario === 'auto_missing_assessment' ? 'hold' : 'approve',
      'Native fixture human inspected the pinned evidence'
    );
    if (scenario === 'auto_changed_input') {
      await store.updateWorkflowRun(workflowRun.id, {
        metadata: {
          inputs: {
            prs: JSON.stringify(
              [2, 1].map(number => ({
                repo: { host: 'example.test', path: 'team/project' },
                number,
              }))
            ),
          },
        },
      });
    }
    assert.equal(await readFile(join(artifacts, 'queue.json'), 'utf8'), snapshot);
    workflowRun = await store.resumeWorkflowRun(workflowRun.id);
  }
  assert.deepEqual(
    pauses,
    scenario === 'green'
      ? ['approve-order', 'approve-candidates']
      : ['auto_changed_input', 'auto_missing_assessment'].includes(scenario)
        ? ['approve-order']
        : scenario === 'auto_failed_review'
          ? ['approve-candidates']
          : []
  );
  const state = await queue();
  assert.equal(
    state.phase,
    scenario === 'auto_changed_input'
      ? 'awaiting_order'
      : ['auto_failed_review', 'auto_missing_assessment'].includes(scenario)
        ? 'held'
        : 'merged'
  );
  const transport = z
    .object({ applied: z.array(z.unknown()) })
    .parse(JSON.parse(await readFile(join(temporary, 'transport.json'), 'utf8')));
  assert.equal(
    transport.applied.length,
    ['auto_failed_review', 'auto_changed_input', 'auto_missing_assessment'].includes(scenario)
      ? 0
      : 2
  );
  console.log(
    JSON.stringify({
      run: workflowRun.id,
      pauses,
      phase: state.phase,
      order: state.order_receipt,
      candidate: state.candidate_receipt,
    })
  );
} finally {
  await closeDatabase();
}
// The failed-node path can retain process timers after terminal persistence.
// This isolated harness owns its process; all execution, readback and DB close
// have settled before exit, and any assertion above still exits unsuccessfully.
process.exit(0);
