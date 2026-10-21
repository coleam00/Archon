import { expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { providerRegistry } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import {
  createDryRunStubScaffold,
  dryRunWorkflow,
  type DryRunResult,
  type DryRunStubs,
} from '../packages/workflows/src/dry-run';
import { isRecord } from '../packages/workflows/src/dry-run/stubs';
import { resolveWorkflow } from '../packages/workflows/src/graph-plan';
import { parseWorkflow } from '../packages/workflows/src/loader';
import { validateStructuredOutput } from '../packages/workflows/src/structured-output';

registerBuiltinProviders();
const track = trackTempRoots();
const repo = resolve(import.meta.dir, '..');
const filename = 'archon-release.yaml';
const source = await Bun.file(join(repo, '.archon/workflows/experimental', filename)).text();

function load() {
  const result = parseWorkflow(source, filename, providerRegistry);
  if (!result.workflow) throw new Error(JSON.stringify(result.error));
  return resolveWorkflow(result.workflow);
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected an object: ${JSON.stringify(value)}`);
  }
  return value;
}

const approvals: DryRunStubs = {
  'review-changelog': { decision: 'approve', text: '' },
  'wait-for-merge': { decision: 'approve', text: '' },
};

function entry(result: DryRunResult, nodeId: string) {
  const found = result.trace.find(item => item.nodeId === nodeId);
  if (!found) throw new Error(`Missing trace for ${nodeId}`);
  return found;
}

function simulate(stubs: DryRunStubs = {}) {
  return dryRunWorkflow({
    workflow: load(),
    cwd: repo,
    userMessage: '',
    defaultStubs: true,
    execCode: false,
    stubs,
  });
}

test('release loader rejects a misspelled consumed producer field', () => {
  const result = parseWorkflow(
    source.replace('$parse-args.output.bump', '$parse-args.output.bmup'),
    filename,
    providerRegistry
  );
  expect(result.workflow).toBeNull();
  expect(result.error?.error).toContain('validate-state');
  expect(result.error?.error).toContain('parse-args');
  expect(result.error?.error).toContain('bmup');
});

test('generated release simulation pauses for changelog review', async () => {
  const result = await simulate();
  expect(result.outcome).toBe('paused');
  expect(entry(result, 'review-changelog').state).toBe('paused');
  expect(result.missingStubs).toEqual([]);
});

test.each(['true', 'false'])('generated release graph resolves with Homebrew %s', async brew => {
  const result = await simulate({ ...approvals, 'check-homebrew': brew });
  expect({
    outcome: result.outcome,
    failures: result.trace.filter(e => e.state === 'failed'),
  }).toEqual({ outcome: 'completed', failures: [] });
  expect(result.missingStubs).toEqual([]);
  for (const id of [
    'write-files',
    'commit-and-push',
    'create-pr',
    'tag-and-release',
    'sync-dev-with-main',
    'final-summary',
  ]) {
    expect(entry(result, id).state).toBe('stubbed');
  }
  for (const id of [
    'wait-for-binaries',
    'fetch-and-update-formula',
    'commit-formula',
    'sync-tap',
  ]) {
    expect(entry(result, id).state).toBe(brew === 'true' ? 'stubbed' : 'skipped');
  }
  expect(result.trace.filter(e => e.reason === 'executed locally')).toEqual([]);
  expect(
    result.trace
      .filter(e => e.nodeType === 'script' || e.nodeType === 'bash')
      .filter(e => e.state === 'completed')
  ).toEqual([]);
});

test('release smoke failure still cancels before version calculation', async () => {
  const stubs = createDryRunStubScaffold(load());
  const result = await simulate({
    'preflight-smoke': { ...object(stubs['preflight-smoke']), passed: 'false' },
  });
  expect(result.outcome).toBe('cancelled');
  expect(result.trace.some(e => e.nodeId === 'bump-version')).toBe(false);
});

test('release review rejection still cancels publication', async () => {
  const result = await simulate({ 'review-changelog': { decision: 'reject', text: '' } });
  expect(result.outcome).toBe('cancelled');
  expect(result.trace.some(e => e.nodeId === 'write-files')).toBe(false);
});

const safeExec = [
  'parse-args',
  'preflight-smoke',
  'detect-stack',
  'bump-version',
  'save-draft-json',
  'format-changelog',
];

function expectProducerContracts(
  workflow: ReturnType<typeof load>,
  executed: DryRunResult['trace']
) {
  for (const trace of executed) {
    if (trace.nodeId === 'save-draft-json') continue;
    const schema = workflow.nodes.find(node => node.id === trace.nodeId)?.output_format;
    if (!schema) throw new Error(`Missing producer contract: ${trace.nodeId}`);
    const output = object(JSON.parse(trace.output ?? ''));
    expect(validateStructuredOutput(output, schema)).toEqual({ valid: true });
    expect(Object.keys(output).sort()).toEqual(Object.keys(object(schema.properties)).sort());
  }
}

test.each([
  {
    stack: 'node',
    file: 'package.json',
    manifest: '{"version":"1.2.3"}',
    bump: 'patch',
    next: '1.2.4',
    message: '',
    dryRun: 'false',
  },
  {
    stack: 'python',
    file: 'pyproject.toml',
    manifest: '[project]\nversion = "1.2.3"\n',
    bump: 'minor',
    next: '1.3.0',
    message: 'minor',
    dryRun: 'false',
  },
  {
    stack: 'rust',
    file: 'Cargo.toml',
    manifest: '[package]\nversion = "1.2.3"\n',
    bump: 'major',
    next: '2.0.0',
    message: 'major',
    dryRun: 'false',
  },
  {
    stack: 'node',
    file: 'package.json',
    manifest: '{"version":"1.2.3"}',
    bump: 'minor',
    next: '1.3.0',
    message: 'minor --dry-run',
    dryRun: 'true',
  },
  {
    stack: 'node',
    file: 'package.json',
    manifest: '{"version":"1.2.3"}',
    bump: 'major',
    next: '2.0.0',
    message: 'major dry-run',
    dryRun: 'true',
  },
])('actual $stack producers conform and feed review for "$message"', async scenario => {
  const cwd = track(await mkdtemp(join(tmpdir(), 'archon-release-contract-')));
  await writeFile(join(cwd, scenario.file), scenario.manifest);
  const workflow = load();
  const stubs: DryRunStubs = {
    ...createDryRunStubScaffold(workflow),
    ...approvals,
    'check-homebrew': 'true',
  };
  for (const id of safeExec) delete stubs[id];
  const result = await dryRunWorkflow({
    workflow,
    cwd,
    execWorkspace: cwd,
    userMessage: scenario.message,
    stubs,
    execCode: true,
  });
  expect({
    outcome: result.outcome,
    failures: result.trace.filter(e => e.state === 'failed'),
  }).toEqual({ outcome: 'completed', failures: [] });
  expect(result.missingStubs).toEqual([]);
  const executed = result.trace.filter(e => e.reason === 'executed locally');
  expect(executed.map(e => e.nodeId).sort()).toEqual([...safeExec].sort());
  expectProducerContracts(workflow, executed);
  expect(JSON.parse(entry(result, 'parse-args').output ?? '')).toEqual({
    bump: scenario.bump,
    dryRun: scenario.dryRun,
  });
  const version = object(JSON.parse(entry(result, 'bump-version').output ?? ''));
  expect(version).toMatchObject({
    oldVersion: '1.2.3',
    newVersion: scenario.next,
    stack: scenario.stack,
    versionFile: scenario.file,
    bump: scenario.bump,
  });
  const smoke = object(JSON.parse(entry(result, 'preflight-smoke').output ?? ''));
  expect(smoke).toMatchObject({ passed: 'true', skipped: 'true' });
  const formatted = object(JSON.parse(entry(result, 'format-changelog').output ?? ''));
  expect(formatted).toMatchObject({ ...version, dryRun: scenario.dryRun });
  const draft = object(stubs['draft-changelog']);
  if (typeof formatted.rendered !== 'string' || typeof draft.summary !== 'string') {
    throw new Error('Expected changelog text and draft summary');
  }
  expect(formatted.rendered).toContain(`## [${scenario.next}]`);
  expect(formatted.rendered).toContain(draft.summary);
  expect(entry(result, 'review-changelog').resolvedText).toContain(formatted.rendered);
  for (const id of [
    'write-files',
    'commit-and-push',
    'create-pr',
    'wait-for-merge',
    'tag-and-release',
    'sync-dev-with-main',
    'wait-for-binaries',
    'fetch-and-update-formula',
    'commit-formula',
    'sync-tap',
  ]) {
    expect(entry(result, id).state).toBe(scenario.dryRun === 'true' ? 'skipped' : 'stubbed');
  }
  expect(entry(result, 'final-summary').state).toBe('stubbed');
});
