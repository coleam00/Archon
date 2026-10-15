import { expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { providerRegistry } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import type { IAgentProvider, MessageChunk, WorkflowConfig, WorkflowDeps } from '../../../packages/workflows/src/deps';
import { createFileWorkflowStore } from '../../../packages/workflows/src/file-store';
import { qualifyWorkflowResources } from '../../../packages/workflows/src/packaged-workflow';
import { parseWorkflow } from '../../../packages/workflows/src/loader';
import { executeTestDagWorkflow, makeTestComposedWorkflow } from '../../../packages/workflows/src/test-utils';
import { liveSourceRoots } from '../../../packages/workflows/src/workflow-source';
import { writeItem } from '../../workflows/sdlc/.shared/review-item';

const track = trackTempRoots();
registerBuiltinProviders();

it('sends saved defects and named lens mechanisms to the judge provider', async () => {
  const root = track(mkdtempSync(join(tmpdir(), 'archon-judge-prompt-')));
  const item = join(root, 'item');
  mkdirSync(join(item, 'review'), { recursive: true });
  writeItem(item, {
    defects: [{ id: 'PLANTED-123', class: 'wrong_behaviour', owner: 'code', claim: 'Counts down.', location: 'a.ts:2' }],
    known_defects: [], lenses: { code: 'review/code.md' },
  });
  const mechanism = 'The decrement at a.ts:2 makes the loop run forever.';
  writeFileSync(join(item, 'review/code.md'), mechanism);
  writeFileSync(join(item, 'review/findings.json'), '[]');
  const source = join(import.meta.dir, '../../..');
  const file = join(source, '.archon/workflows/sdlc/review-eval-judge/archon-review-eval-judge.yaml');
  const parsed = parseWorkflow(readFileSync(file, 'utf8'), file, providerRegistry);
  if (parsed.workflow === null) throw new Error(JSON.stringify(parsed.error));
  qualifyWorkflowResources(parsed.workflow, { source: 'project', pack: 'sdlc', workflow: 'review-eval-judge' });
  const workflow = makeTestComposedWorkflow([parsed.workflow], parsed.workflow.name);
  const store = await createFileWorkflowStore({ root: join(root, 'store') });
  const run = await store.createWorkflowRun({ workflow_name: workflow.name, user_message: '', metadata: { inputs: { item } } });
  await store.claimPendingWorkflowRun(run.id, root);
  const prompts: string[] = [];
  const options: Parameters<IAgentProvider['sendQuery']>[3][] = [];
  const capabilities = providerRegistry.get('claude')?.capabilities;
  if (!capabilities) throw new Error('Claude descriptor missing');
  const provider: IAgentProvider = {
    getType: () => 'claude', getCapabilities: () => capabilities,
    checkCredential: async () => ({ state: 'not_checked', source: 'native' }),
    async *sendQuery(prompt, _cwd, _resume, sentOptions): AsyncGenerator<MessageChunk> {
      prompts.push(prompt);
      options.push(sentOptions);
      yield { type: 'result', structuredOutput: { defects: [{ id: 'PLANTED-123', caught_by: ['code'], finding: null, evidence: 'States the mechanism.' }], shape_unmatched: 0 } };
      yield { type: 'settled' };
    },
  };
  const config: WorkflowConfig = { assistant: 'claude', assistants: { claude: {}, codex: {} }, commands: {}, baseBranch: '' };
  const deps: WorkflowDeps = { providers: providerRegistry, store, getAgentProvider: () => provider, loadConfig: async () => config };
  await executeTestDagWorkflow({
    deps, workflow, workflowRun: run, cwd: root, conversationId: 'judge-test', config,
    platform: { sendMessage: async () => {}, getPlatformType: () => 'test', getStreamingMode: () => 'batch' },
    workflowProvider: 'claude', workflowModel: undefined,
    artifactsDir: join(root, 'artifacts'), logDir: join(root, 'logs'), stateDir: join(root, 'state'), baseBranch: '', docsDir: '',
    workflowSourceRoots: liveSourceRoots(source),
  });
  expect(prompts).toHaveLength(1);
  expect(options[0]?.nodeConfig?.allowed_tools).toEqual([]);
  expect(prompts[0]).toContain('PLANTED-123');
  expect(prompts[0]).toContain('<lens name="code" file="review/code.md">');
  expect(prompts[0]).toContain(mechanism);
  expect((await store.getWorkflowRun(run.id))?.status).toBe('completed');
});
