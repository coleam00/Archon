import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, clearConfigCache } from '@archon/core';
import { setPlatformPolicies } from '@archon/core/platforms/registry';
import { removeTempTree } from '@archon/paths/test-utils';
import { clearRegistry, providerRegistry, registerProvider } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { descriptor } from '@archon/providers/claude/descriptor';
import type { CheckResult } from './doctor-check';
import { checkInstalledProviders } from './doctor-providers';
import { checkWorkflowProviderSelection } from './doctor-workflow-providers';

const hostCheck = async (): Promise<CheckResult> => ({
  label: 'Host check',
  status: 'skip',
  message: 'isolated from workflow-provider acceptance tests',
});
mock.module('./doctor-database', () => ({ checkDatabase: hostCheck }));
mock.module('./doctor-folder-project', () => ({ checkFolderProject: hostCheck }));
const connectedProviders = await import('./doctor-connected-providers');
mock.module('./doctor-connected-providers', () => ({
  ...connectedProviders,
  checkConnectedProviders: hostCheck,
}));
mock.module('./doctor-install', () => ({
  checkWorkspaceWritable: hostCheck,
  checkBundledDefaults: hostCheck,
  checkTelemetry: hostCheck,
}));
mock.module('./doctor-skill', () => ({ checkArchonSkill: hostCheck }));
mock.module('./doctor-platforms', () => ({
  checkGitHubApp: hostCheck,
  checkSlack: hostCheck,
  checkTelegram: hostCheck,
}));
const providerChecks = await import('./doctor-providers');
mock.module('./doctor-providers', () => ({
  ...providerChecks,
  checkProviderDiagnostics: async () => [],
}));
const { doctorCommand } = await import('./doctor');

const savedEnv = { ...process.env };
const savedCwd = process.cwd();
let root: string;
let project: string;
let output: ReturnType<typeof spyOn<Console, 'log'>>;
const configText = 'defaults:\n  loadDefaultWorkflows: false\n  loadDefaultCommands: false\n';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-doctor-workflows-'));
  project = join(root, 'project');
  await mkdir(join(project, '.archon/workflows'), { recursive: true });
  process.env.ARCHON_HOME = join(root, 'home');
  process.env.DEFAULT_AI_ASSISTANT = '';
  process.env.LOG_LEVEL = 'silent';
  process.chdir(project);
  setPlatformPolicies([]);
  clearRegistry();
  clearConfigCache();
  registerBuiltinProviders();
  await writeFile(join(project, '.archon/config.yaml'), configText);
  output = spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  output.mockRestore();
  clearRegistry();
  clearConfigCache();
  process.chdir(savedCwd);
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await removeTempTree(root);
});

async function workflow(body: string, prefix = '', global = false) {
  const folder = global ? join(root, 'home/workflows') : join(project, '.archon/workflows');
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, 'probe.yaml'),
    `name: probe\ndescription: Doctor fixture\n${prefix}nodes:\n${body}`
  );
}

async function focusedDoctor() {
  const selection = await checkWorkflowProviderSelection();
  output.mockClear();
  const exit = await doctorCommand();
  return { ...selection, exit };
}

test('missing default fails with the remedy; explicit provider scopes remain supported', async () => {
  expect((await loadConfig(project)).assistant).toBeUndefined();
  for (const body of [
    '  - id: ai\n    prompt: hello\n',
    '  - id: group\n    loop_group:\n      max_iterations: 1\n      until: done\n      nodes:\n        - id: ai\n          prompt: hello\n',
    '  - id: gate\n    approval:\n      message: Review\n      on_reject:\n        prompt: revise\n        max_attempts: 1\n',
  ]) {
    await workflow(body);
    const result = await focusedDoctor();
    expect(result.check.status).toBe('fail');
    expect(result.exit).toBe(1);
    expect(result.check.message).toContain('probe');
    expect(output.mock.calls.flat().join('\n')).toContain('archon ai default <provider>');
    expect(output.mock.calls.flat().join('\n')).toContain('archon setup');
    expect(output.mock.calls.flat().join('\n')).toContain('✗ Workflow providers: probe');
  }
  await rm(join(project, '.archon/workflows/probe.yaml'));
  await workflow('  - id: ai\n    prompt: hello\n', '', true);
  expect((await focusedDoctor()).exit).toBe(1);
  await rm(join(root, 'home/workflows/probe.yaml'));
  for (const [body, prefix, extraConfig] of [
    ['  - id: ai\n    provider: codex\n    prompt: hello\n', '', ''],
    ['  - id: ai\n    prompt: hello\n', 'provider: codex\n', ''],
    [
      '  - id: ai\n    model: large\n    prompt: hello\n',
      '',
      'tiers:\n  large:\n    provider: codex\n    model: gpt-5.5\n',
    ],
  ]) {
    await writeFile(join(project, '.archon/config.yaml'), configText + extraConfig);
    await workflow(body, prefix);
    const result = await focusedDoctor();
    expect(result.check.status).toBe('pass');
    expect(result.allowEmptyProviderInventory).toBe(false);
    expect(result.exit).toBe(0);
  }
});

test('script and bash workflows, or no workflows, pass with no providers; broken inventory still fails', async () => {
  clearRegistry();
  for (const body of [
    '  - id: shell\n    bash: "true"\n  - id: code\n    script: console.log(1)\n    runtime: bun\n',
    undefined,
  ]) {
    if (body) await workflow(body);
    else await rm(join(project, '.archon/workflows/probe.yaml'));
    const result = await focusedDoctor();
    expect(result.check.status).toBe('pass');
    expect(result.exit).toBe(0);
    expect(result.allowEmptyProviderInventory).toBe(true);
    expect(output.mock.calls.flat().join('\n')).toContain(
      '○ Installed providers: Discovered workflows need no provider'
    );
    const broken = await checkInstalledProviders(
      providerRegistry,
      async () => ({
        versions: new Map(),
        notices: ['broken provider receipt'],
      }),
      result.allowEmptyProviderInventory
    );
    expect(broken.status).toBe('fail');
    const unavailable = await checkInstalledProviders(
      {
        ...providerRegistry,
        unavailable: id => (id === 'codex' ? 'codex plugin unavailable' : undefined),
      },
      async () => ({ versions: new Map(), notices: [] }),
      result.allowEmptyProviderInventory
    );
    expect(unavailable.status).toBe('fail');
  }
  await workflow('  - id: bad\n');
  const invalid = await checkWorkflowProviderSelection();
  expect(invalid.check.status).toBe('fail');
  expect(invalid.allowEmptyProviderInventory).toBe(false);
});

test('resolved defaults keep the existing config and login outcome and skip discovery', async () => {
  clearRegistry();
  registerProvider({
    id: 'fixture',
    displayName: 'Fixture',
    builtIn: false,
    capabilities: descriptor.capabilities,
    credentials: { kind: 'static', specs: [], vendorFor: () => undefined },
    parseConfig: raw => raw,
    factory: () => ({
      checkCredential: async () => ({ state: 'not_checked', source: 'native' }),
      getType: () => 'fixture',
      getCapabilities: () => descriptor.capabilities,
      async *sendQuery() {
        throw new Error('unused');
      },
    }),
  });
  await workflow('  - id: invalid\n');
  for (const extra of ['defaultAssistant: fixture\n', '']) {
    await writeFile(join(project, '.archon/config.yaml'), configText + extra);
    expect((await loadConfig(project)).assistant).toBe('fixture');
    const result = await focusedDoctor();
    expect(result.check.status).toBe('skip');
    expect(result.allowEmptyProviderInventory).toBe(false);
    expect(result.exit).toBe(0);
    expect(output.mock.calls.flat().join('\n')).toContain('fixture: not checked');
  }
});
