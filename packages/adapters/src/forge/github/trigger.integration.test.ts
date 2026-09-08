import { afterAll, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { registerBuiltinProviders } from '@archon/providers';

const root = await mkdtemp(join(tmpdir(), 'archon-github-trigger-'));
const previous = {
  home: process.env.ARCHON_HOME,
  database: process.env.DATABASE_URL,
  users: process.env.GITHUB_ALLOWED_USERS,
};
process.env.ARCHON_HOME = join(root, 'home');
process.env.DATABASE_URL = '';
process.env.GITHUB_ALLOWED_USERS = 'operator';
registerBuiltinProviders();
const { GitHubAdapter } = await import('./adapter');
const { closeDatabase, getDatabase } = await import('@archon/core/db/connection');
const { createCodebase } = await import('@archon/core/db/codebases');
const { createWorkflowTriggerStore } = await import('@archon/core/db/workflow-triggers');
const { waitForRunAttention } = await import('@archon/core/services/run-attention-watch');
const project = join(root, 'project');
await mkdir(join(project, '.archon', 'workflows'), { recursive: true });
await writeFile(
  join(project, '.archon', 'config.yaml'),
  'defaults:\n  loadDefaultWorkflows: false\n'
);
await writeFile(
  join(project, '.archon', 'workflows', 'issue.yaml'),
  'name: issue\ndescription: Issue trigger fixture\nworktree:\n  enabled: false\ninputs:\n  issue:\n    required: true\nnodes:\n  - id: intake\n    wait:\n      attention: Review qualified issue $INPUTS.issue\n'
);
const codebase = await createCodebase({
  name: 'github-trigger',
  default_cwd: project,
  kind: 'folder',
});
const binding = {
  id: 'intake',
  kind: 'github.issue',
  workflow: 'issue',
  codebaseId: codebase.id,
  sourceRoot: project,
  source: 'project',
  overlap: 'allow',
  repository: 'example/repo',
  actors: ['operator'],
  action: 'opened',
  facts: { issue: 'issueUrl' },
};
await writeFile(join(process.env.ARCHON_HOME, 'triggers.json'), JSON.stringify([binding]));
const payload = {
  action: 'opened',
  issue: { number: 42, state: 'open', body: '@Archon /command arbitrary' },
  repository: { full_name: 'example/repo', owner: { login: 'example' }, name: 'repo' },
  sender: { login: 'operator' },
};
const adapter = new GitHubAdapter({ kind: 'pat', token: 'unused-test-token' }, 'secret', {
  async acquireLock() {
    throw new Error('Trigger must never dispatch a conversation agent');
  },
});
function signature(raw: string) {
  return `sha256=${createHmac('sha256', 'secret').update(raw).digest('hex')}`;
}

afterAll(async () => {
  await closeDatabase();
  await removeTempTree(root);
  for (const [key, value] of Object.entries({
    ARCHON_HOME: previous.home,
    DATABASE_URL: previous.database,
    GITHUB_ALLOWED_USERS: previous.users,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('signed issue-opened fixture admits exactly one workflow without a mention or chat fallback', async () => {
  const raw = JSON.stringify(payload);
  await Promise.all([
    adapter.handleWebhook(raw, signature(raw), 'delivery', 'issues'),
    adapter.handleWebhook(raw, signature(raw), 'delivery', 'issues'),
  ]);
  const admission = await createWorkflowTriggerStore().getAdmission('intake', 'delivery');
  expect(admission).not.toBeNull();
  const attention = await waitForRunAttention(admission!.runId, { deadlineMs: 3000 });
  expect(attention.kind).toBe('attention');
  const nodes = await getDatabase().query<{ step_name: string }>(
    "SELECT step_name FROM remote_agent_workflow_events WHERE workflow_run_id = $1 AND event_type = 'wait_started'",
    [admission!.runId]
  );
  expect(nodes.rows.map(row => row.step_name)).toEqual(['intake']);
});

test('bad signatures, actors, repositories and malformed identities never admit a run', async () => {
  const raw = JSON.stringify(payload);
  await adapter.handleWebhook(raw, 'sha256=bad', 'bad-signature', 'issues');
  const unauthorized = JSON.stringify({ ...payload, sender: { login: 'intruder' } });
  await adapter.handleWebhook(unauthorized, signature(unauthorized), 'bad-actor', 'issues');
  const otherRepo = JSON.stringify({
    ...payload,
    repository: { full_name: 'other/repo', owner: { login: 'other' }, name: 'repo' },
  });
  await adapter.handleWebhook(otherRepo, signature(otherRepo), 'bad-repo', 'issues');
  await expect(adapter.handleWebhook(raw, signature(raw), undefined, 'issues')).rejects.toThrow();
  for (const eventId of ['bad-signature', 'bad-actor', 'bad-repo'])
    expect(await createWorkflowTriggerStore().getAdmission('intake', eventId)).toBeNull();
});

test('labeled fixtures require the configured added label and reject ambiguous routes', async () => {
  const labeledBinding = { ...binding, id: 'labeled', action: 'labeled', label: 'ready' };
  const configPath = join(process.env.ARCHON_HOME!, 'triggers.json');
  await writeFile(configPath, JSON.stringify([labeledBinding]));
  const raw = JSON.stringify({ ...payload, action: 'labeled', label: { name: 'ready' } });
  await adapter.handleWebhook(raw, signature(raw), 'labeled-delivery', 'issues');
  const admission = await createWorkflowTriggerStore().getAdmission('labeled', 'labeled-delivery');
  expect(admission).not.toBeNull();
  expect((await waitForRunAttention(admission!.runId, { deadlineMs: 3000 })).kind).toBe(
    'attention'
  );
  const other = JSON.stringify({ ...payload, action: 'labeled', label: { name: 'other' } });
  await adapter.handleWebhook(other, signature(other), 'other-label', 'issues');
  expect(await createWorkflowTriggerStore().getAdmission('labeled', 'other-label')).toBeNull();
  await writeFile(
    configPath,
    JSON.stringify([labeledBinding, { ...labeledBinding, id: 'ambiguous' }])
  );
  await expect(
    adapter.handleWebhook(raw, signature(raw), 'ambiguous-delivery', 'issues')
  ).rejects.toThrow('Ambiguous');
  await writeFile(
    configPath,
    JSON.stringify([{ ...labeledBinding, actors: ['another-operator'] }])
  );
  await expect(
    adapter.handleWebhook(raw, signature(raw), 'binding-denied', 'issues')
  ).rejects.toThrow('unauthorized');
});
