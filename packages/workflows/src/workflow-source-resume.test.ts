// @archon-test-isolated
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';
import { packTreePath, receiptPath } from '@archon/plugin-manifest/store';
import { providerRegistry, claudeDescriptor } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { createFileWorkflowStore } from './file-store';
import { InProcessWorkflowEngine } from './in-process-engine';
import {
  captureWorkflowSource,
  capturedSourceRoots,
  openWorkflowSource,
  verifyWorkflowSourceUnits,
  WorkflowSourceUnavailableError,
  WorkflowSourceIntegrityError,
  type WorkflowSourceCapture,
} from './workflow-source';
import { resolveCommandContentForScan } from './workflow-discovery/command-scan';
import { loadCommandPrompt } from './load-command-prompt';
import { discoverScriptsForCwd } from './script-discovery';
import { discoverWorkflowsWithConfig } from './workflow-discovery';
import { resolveFanOutChildDefinition } from './dag/nodes/compose-fan-out/compose-fan-out';
import { collectComposedSuspensionPaths } from './include/suspension';
import { formatPackagedResourceReference } from './packaged-workflow';
import { WORKFLOW_SOURCE_METADATA_KEY, type WorkflowRun } from './schemas/workflow-run';
import type { WorkflowDeps, IWorkflowPlatform } from './deps';

const bundleRoot = await mkdtemp(join(tmpdir(), 'resume-bundle-'));
afterAll(() => removeTempTree(bundleRoot));
const paths = await import('@archon/paths');
mock.module('@archon/paths', () => ({ ...paths, getBundledWorkflowsPath: () => bundleRoot }));
const bundleInventory = await import('./defaults/bundle-inventory');
spyOn(bundleInventory, 'readBundleIndex').mockResolvedValue([]);
registerBuiltinProviders();
const track = trackTempRoots();
const platform: IWorkflowPlatform = {
  sendMessage: async () => {},
  getStreamingMode: () => 'batch',
  getPlatformType: () => 'test',
};
const loadConfig: WorkflowDeps['loadConfig'] = async () => ({
  assistant: 'claude',
  assistants: { claude: {}, codex: {} },
  commands: {},
  baseBranch: 'dev',
});
let root: string;
let project: string;
let previousHome: string | undefined;

beforeEach(async () => {
  root = track(await mkdtemp(join(tmpdir(), 'source-resume-')));
  project = join(root, 'project');
  previousHome = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = join(root, 'home');
  await mkdir(project, { recursive: true });
  await install('broken', { 'run/run.yaml': workflow('run', '  - id: wrong\n    bash: exit 98') });
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousHome;
});

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
function workflow(name: string, nodes: string): string {
  return `name: ${name}\ndescription: Source resume fixture\nnodes:\n${nodes}\n`;
}
const first = '  - id: first\n    bash: exit 99';
const remaining = '  - id: remaining\n    script: check\n    runtime: bun\n    depends_on: [first]';

async function install(
  name: string,
  files: Record<string, string>,
  entrypoints: Record<string, string> = { run: 'run/run.yaml' }
): Promise<void> {
  const plugins = join(root, 'home/plugins');
  const id = `acme/${name}`;
  const commit = 'a'.repeat(40);
  const manifest = {
    schemaVersion: 1,
    kind: 'workflow-pack',
    name,
    description: 'Fixture',
    entrypoints,
  };
  const tree = packTreePath(plugins, id, commit);
  for (const [path, content] of Object.entries({
    ...files,
    'archon-plugin.json': JSON.stringify(manifest),
  })) {
    await put(join(tree, path), content);
  }
  await put(
    receiptPath(plugins, id),
    JSON.stringify({
      schemaVersion: 1,
      id,
      commit,
      manifest,
      installedAt: new Date(0).toISOString(),
    })
  );
}
function metadata(capture: WorkflowSourceCapture) {
  return {
    [WORKFLOW_SOURCE_METADATA_KEY]: {
      version: 1,
      root: capture.anchor.root,
      origin: project,
      captured_at: capture.manifest.captured_at,
      digest: capture.manifest.digest,
      file_count: capture.manifest.file_count,
      byte_count: capture.manifest.byte_count,
      source_config: capture.manifest.source_config,
    },
  };
}
async function pausedRun(name = 'healthy', firstOutput = 'already-done') {
  const capture = await captureWorkflowSource({
    sourceRoot: project,
    captureRoot: join(root, 'capture'),
  });
  const store = await createFileWorkflowStore({ root: join(root, 'store') });
  const created = await store.createWorkflowRun({
    workflow_name: name,
    user_message: '',
    working_path: project,
    metadata: metadata(capture),
  });
  await store.claimPendingWorkflowRun(created.id, project);
  await store.persistWorkflowEvent({
    workflow_run_id: created.id,
    event_type: 'node_completed',
    step_name: 'first',
    data: { node_output: firstOutput },
  });
  await store.pauseWorkflowRun(created.id, {
    type: 'approval',
    nodeId: 'first',
    message: '',
    pauseId: 'paused',
  });
  const run = await store.getWorkflowRun(created.id);
  if (!run) throw new Error('Missing paused run');
  const deps: WorkflowDeps = {
    providers: providerRegistry,
    store,
    loadConfig,
    getAgentProvider: () => {
      throw new Error('No agent expected');
    },
  };
  const engine = new InProcessWorkflowEngine(deps);
  const resume = async (record: WorkflowRun = run) => {
    const admission = await engine.resume({
      platform,
      conversationId: 'resume-proof',
      cwd: project,
      userMessage: '',
      run: record,
    });
    if (!admission.accepted) throw new Error('Resume was refused');
    return admission.settled;
  };
  return { capture, store, run, resume, deps };
}
const originalRead = fs.readFile;
function denyReads(path: string | string[]) {
  const read = originalRead;
  const cause = Object.assign(new Error('persistent read fault'), {
    code: 'EACCES',
    syscall: 'open',
    path,
  });
  return spyOn(fs, 'readFile').mockImplementation(
    new Proxy(read, {
      apply(target, thisArg, args: Parameters<typeof read>) {
        if (
          (typeof path === 'string' ? [path] : path).some(blocked =>
            String(args[0]).startsWith(blocked)
          )
        )
          return Promise.reject(cause);
        return Reflect.apply(target, thisArg, args);
      },
    })
  );
}
const packScript = (pack: string) =>
  formatPackagedResourceReference(
    { source: 'installed', pack: `acme.${pack}`, workflow: 'run' },
    'check'
  );

for (const installed of [false, true]) {
  test(`resume executes frozen ${installed ? 'installed' : 'project'} source under persistent unrelated EACCES`, async () => {
    if (installed) {
      await install('healthy', {
        'run/run.yaml': workflow('run', `${first}\n${remaining}`),
        'run/scripts/check.ts': "console.log('frozen-result');",
      });
    } else {
      await put(
        join(project, '.archon/workflows/healthy.yaml'),
        workflow('healthy', `${first}\n${remaining}`)
      );
      await put(join(project, '.archon/scripts/check.ts'), "console.log('frozen-result');");
    }
    const fixture = await pausedRun(installed ? 'acme/healthy:run' : 'healthy');
    await put(
      join(project, '.archon/scripts/check.ts'),
      "throw new Error('live source must not execute');"
    );
    const fault = denyReads(join(fixture.capture.anchor.root, 'installed/acme.broken'));
    try {
      expect(await fixture.resume()).toMatchObject({ success: true });
      expect(await fixture.store.getWorkflowRunStatus(fixture.run.id)).toBe('completed');
      const snapshot = await fixture.store.getDagResumeSnapshot(fixture.run.id);
      expect(snapshot.completedNodeOutputs.get('first')?.output).toBe('already-done');
      expect(snapshot.completedNodeOutputs.get('remaining')?.output).toContain('frozen-result');
    } finally {
      fault.mockRestore();
    }
  });
}

test('selected-unit read fault refuses admission and resumes after restoration', async () => {
  await put(
    join(project, '.archon/workflows/healthy.yaml'),
    workflow('healthy', `${first}\n${remaining}`)
  );
  await put(join(project, '.archon/scripts/check.ts'), "console.log('restored-result');");
  const fixture = await pausedRun();
  const fault = denyReads(join(fixture.capture.anchor.root, 'project'));
  try {
    await expect(fixture.resume()).rejects.toBeInstanceOf(WorkflowSourceUnavailableError);
    expect(await fixture.store.getWorkflowRunStatus(fixture.run.id)).toBe('paused');
    expect(
      (await fixture.store.getDagResumeSnapshot(fixture.run.id)).completedNodeOutputs.has(
        'remaining'
      )
    ).toBe(false);
  } finally {
    fault.mockRestore();
  }
  expect(await fixture.resume()).toMatchObject({ success: true });
});

test('a runtime-substituted script verifies its installed owner and recovers after a required read fault', async () => {
  await put(
    join(project, '.archon/workflows/healthy.yaml'),
    workflow('healthy', `${first}\n${remaining.replace('script: check', 'script: $first.output')}`)
  );
  await install('resource', {
    'run/run.yaml': workflow('run', '  - id: unused\n    bash: exit 98'),
    'run/scripts/check.ts': "console.log('resource-result');",
  });
  const fixture = await pausedRun('healthy', packScript('resource'));
  const blocked = [
    join(fixture.capture.anchor.root, 'installed/acme.broken'),
    join(fixture.capture.anchor.root, 'installed/acme.resource'),
  ];
  const fault = denyReads(blocked);
  try {
    await fixture.resume();
    expect(
      (await fixture.store.getWorkflowRun(fixture.run.id))?.metadata.source_release
    ).toBeDefined();
    expect(await fixture.store.getWorkflowRunStatus(fixture.run.id)).toBe('paused');
    expect(
      (await fixture.store.getDagResumeSnapshot(fixture.run.id)).completedNodeOutputs.has(
        'remaining'
      )
    ).toBe(false);
    blocked.pop();
    const run = await fixture.store.getWorkflowRun(fixture.run.id);
    if (!run) throw new Error('Missing released run');
    expect(await fixture.resume(run)).toMatchObject({ success: true });
    expect(
      (await fixture.store.getDagResumeSnapshot(run.id)).completedNodeOutputs.get('remaining')
        ?.output
    ).toContain('resource-result');
  } finally {
    fault.mockRestore();
  }
});

for (const faultKind of ['unreadable', 'tampered']) {
  test(`a resumed parent launches a child while retaining an ${faultKind} inherited pack commitment`, async () => {
    await put(
      join(project, '.archon/workflows/healthy.yaml'),
      workflow('healthy', `${first}\n  - id: child\n    workflow: child\n    depends_on: [first]`)
    );
    await install('healthy', {
      'run/run.yaml': workflow('run', '  - id: unused\n    bash: exit 98'),
      'run/scripts/check.ts': "console.log('inherited-result');",
    });
    const fixture = await pausedRun();
    await put(
      join(
        packTreePath(join(root, 'home/plugins'), 'acme/healthy', 'a'.repeat(40)),
        'run/scripts/check.ts'
      ),
      "throw new Error('updated live pack must not execute');"
    );
    await put(
      join(project, '.archon/workflows/child.yaml'),
      workflow(
        'child',
        `  - id: remaining\n    script: check\n    runtime: bun\n  - id: inherited\n    script: ${packScript('healthy')}\n    runtime: bun\n    depends_on: [remaining]`
      )
    );
    await put(join(project, '.archon/scripts/check.ts'), "console.log('live-child-result');");
    const brokenFile = join(fixture.capture.anchor.root, 'installed/acme.broken/run/run.yaml');
    const originalBytes = await fs.readFile(brokenFile);
    if (faultKind === 'tampered') {
      await put(brokenFile, 'tampered source');
      await expect(
        verifyWorkflowSourceUnits(fixture.capture.anchor, ['installed/acme.broken'])
      ).rejects.toBeInstanceOf(WorkflowSourceIntegrityError);
    }
    const fault =
      faultKind === 'unreadable'
        ? denyReads(join(fixture.capture.anchor.root, 'installed/acme.broken'))
        : undefined;
    try {
      const result = await fixture.resume();
      expect(result).toMatchObject({ success: true });
      const children = await fixture.store.findChildRuns(fixture.run.id);
      expect(children).toHaveLength(1);
      const child = children[0];
      expect(child.status).toBe('completed');
      const state = (await import('./schemas/workflow-run')).readWorkflowSourceState(
        child.metadata
      );
      if (state.kind !== 'recorded') throw new Error('Child lost source record');
      const capture = await openWorkflowSource(
        state.record.root,
        state.record.digest,
        state.record.source_config
      );
      expect(capture.manifest.version).toBe(3);
      if (capture.manifest.version !== 3 || fixture.capture.manifest.version !== 3)
        throw new Error('Expected indexed capture');
      expect(capture.manifest.units.find(unit => unit.root === 'installed/acme.broken')).toEqual(
        fixture.capture.manifest.units.find(unit => unit.root === 'installed/acme.broken')
      );
      expect(capture.manifest.installed_plugins).toEqual(
        fixture.capture.manifest.installed_plugins
      );
      await expect(
        verifyWorkflowSourceUnits(capture.anchor, ['installed/acme.broken'])
      ).rejects.toBeInstanceOf(WorkflowSourceUnavailableError);
      await expect(
        discoverWorkflowsWithConfig(
          project,
          loadConfig,
          providerRegistry,
          capturedSourceRoots(capture.anchor, 'acme/broken:run')
        )
      ).rejects.toBeInstanceOf(WorkflowSourceUnavailableError);
      const outputs = (await fixture.store.getDagResumeSnapshot(child.id)).completedNodeOutputs;
      expect(outputs.get('remaining')?.output).toContain('live-child-result');
      expect(outputs.get('inherited')?.output).toContain('inherited-result');
      if (faultKind === 'tampered') await fs.writeFile(brokenFile, originalBytes);
      await fs.cp(
        join(fixture.capture.anchor.root, 'installed/acme.broken'),
        join(capture.anchor.root, 'installed/acme.broken'),
        { recursive: true }
      );
      await verifyWorkflowSourceUnits(capture.anchor, ['installed/acme.broken']);
      const restored = await discoverWorkflowsWithConfig(
        project,
        loadConfig,
        providerRegistry,
        capturedSourceRoots(capture.anchor, 'acme/broken:run')
      );
      expect(restored.workflows.map(entry => entry.workflow.name)).toEqual(['acme/broken:run']);
    } finally {
      fault?.mockRestore();
    }
  });
}

test('resume expands an installed support include and executes its frozen resource', async () => {
  await install('healthy', {
    'run/run.yaml': workflow(
      'run',
      `${first}\n  - id: support\n    include: support\n    depends_on: [first]`
    ),
    'support/support.yaml': workflow(
      'support',
      '  - id: remaining\n    script: check\n    runtime: bun'
    ),
    'support/scripts/check.ts': "console.log('included-result');",
  });
  const fixture = await pausedRun('acme/healthy:run');
  const fault = denyReads(join(fixture.capture.anchor.root, 'installed/acme.broken'));
  try {
    expect(await fixture.resume()).toMatchObject({ success: true });
    const outputs = (await fixture.store.getDagResumeSnapshot(fixture.run.id)).completedNodeOutputs;
    expect([...outputs.values()].some(output => output.output.includes('included-result'))).toBe(
      true
    );
    expect(outputs.get('first')?.output).toBe('already-done');
  } finally {
    fault.mockRestore();
  }
});

test('runtime composition resolves only its selected pack under persistent unrelated EACCES', async () => {
  await install('healthy', {
    'run/run.yaml': workflow(
      'run',
      `${first}\n  - id: composed\n    include: support\n    depends_on: [first]\n    fan_out:\n      items: $first.output\n      as: item\n      max_parallel: 1\n      join: all_success`
    ),
    'support/support.yaml': workflow(
      'support',
      '  - id: remaining\n    script: check\n    runtime: bun'
    ),
    'support/scripts/check.ts': "console.log('composed-result');",
  });
  const fixture = await pausedRun('acme/healthy:run', '["one"]');
  const fault = denyReads(join(fixture.capture.anchor.root, 'installed/acme.broken'));
  try {
    expect(await fixture.resume()).toMatchObject({ success: true });
    const outputs = (await fixture.store.getDagResumeSnapshot(fixture.run.id)).completedNodeOutputs;
    expect([...outputs.values()].some(output => output.output.includes('composed-result'))).toBe(
      true
    );
    expect(outputs.get('first')?.output).toBe('["one"]');
  } finally {
    fault.mockRestore();
  }
});

test('authenticated installed names cannot be shadowed by legacy workflows under a read fault', async () => {
  await put(join(project, '.archon/workflows/healthy.yaml'), workflow('healthy', first));
  await put(
    join(project, '.archon/workflows/shadow.yaml'),
    workflow('acme/broken:run', '  - id: wrong\n    bash: exit 97')
  );
  const fixture = await pausedRun();
  const fault = denyReads(join(fixture.capture.anchor.root, 'installed/acme.broken'));
  try {
    const catalog = await discoverWorkflowsWithConfig(
      project,
      loadConfig,
      providerRegistry,
      capturedSourceRoots(fixture.capture.anchor, 'healthy')
    );
    expect(catalog.workflows.map(entry => entry.workflow.name)).toEqual(['healthy']);
    expect(
      catalog.errors.some(error => error.error.includes('belongs to an installed plugin'))
    ).toBe(true);
    await expect(
      discoverWorkflowsWithConfig(
        project,
        loadConfig,
        providerRegistry,
        capturedSourceRoots(fixture.capture.anchor, 'acme/broken:run')
      )
    ).rejects.toBeInstanceOf(WorkflowSourceUnavailableError);
  } finally {
    fault.mockRestore();
  }
});

test('selected discovery and resource lookup ignore injected unindexed scopes and packs', async () => {
  await put(join(project, '.archon/workflows/healthy.yaml'), workflow('healthy', first));
  const fixture = await pausedRun();
  const roots = capturedSourceRoots(fixture.capture.anchor, 'healthy');
  await put(
    join(fixture.capture.anchor.root, 'global/workflows/injected.yaml'),
    workflow('injected', first)
  );
  await put(join(fixture.capture.anchor.root, 'global/commands/injected.md'), 'injected-command');
  await put(
    join(fixture.capture.anchor.root, 'global/scripts/injected.ts'),
    "throw new Error('injected');"
  );
  await put(
    join(fixture.capture.anchor.root, 'installed/acme.injected/run/scripts/check.ts'),
    "throw new Error('injected');"
  );
  const catalog = await discoverWorkflowsWithConfig(project, loadConfig, providerRegistry, roots);
  expect(catalog.workflows.map(entry => entry.workflow.name)).toEqual(['healthy']);
  expect(
    await loadCommandPrompt({ loadConfig }, project, 'injected', undefined, roots)
  ).toMatchObject({ success: false, reason: 'not_found' });
  const scripts = await discoverScriptsForCwd(
    project,
    roots,
    new Set(['injected', packScript('injected')])
  );
  expect(scripts.size).toBe(0);
});

test('resume reads an included command and global MCP config without scanning unrelated packs', async () => {
  await put(
    join(project, '.archon/workflows/healthy.yaml'),
    workflow('healthy', `${first}\n  - id: support\n    include: support\n    depends_on: [first]`)
  );
  await put(
    join(root, 'home/workflows/support.yaml'),
    workflow('support', '  - id: remaining\n    command: check\n    mcp: servers.json')
  );
  await put(
    join(root, 'home/workflows/servers.json'),
    JSON.stringify({ mcpServers: { example: { command: 'echo', args: ['fixture'] } } })
  );
  await put(join(root, 'home/commands/check.md'), 'frozen-command-result');
  const fixture = await pausedRun();
  const prompts: string[] = [];
  fixture.deps.getAgentProvider = () => ({
    checkCredential: async () => ({ state: 'not_checked', source: 'native' }),
    getType: () => 'claude',
    getCapabilities: () => claudeDescriptor.capabilities,
    async *sendQuery(prompt, _cwd, _sessionId, options) {
      prompts.push(prompt);
      expect(options?.nodeConfig?.mcp).toBe(
        join(fixture.capture.anchor.root, 'global/workflows/servers.json')
      );
      yield { type: 'agent_message_chunk', text: 'command-completed' };
      yield { type: 'result', sessionId: 'source-proof' };
      yield { type: 'settled' };
    },
  });
  const fault = denyReads(join(fixture.capture.anchor.root, 'installed/acme.broken'));
  try {
    expect(await fixture.resume()).toMatchObject({ success: true });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('frozen-command-result');
  } finally {
    fault.mockRestore();
  }
});

test('child captures preserve empty directories in inherited installed units', async () => {
  await put(join(project, '.archon/workflows/healthy.yaml'), workflow('healthy', first));
  const directories = ['empty', 'run/scripts/output/nested'];
  for (const directory of directories) {
    await mkdir(
      join(packTreePath(join(root, 'home/plugins'), 'acme/broken', 'a'.repeat(40)), directory),
      { recursive: true }
    );
  }
  const fixture = await pausedRun();
  const child = await captureWorkflowSource({
    sourceRoot: project,
    captureRoot: join(root, 'child-capture'),
    installedFrom: { kind: 'captured', anchor: fixture.capture.anchor },
  });
  for (const directory of directories) {
    expect(await fs.readdir(join(child.anchor.root, 'installed/acme.broken', directory))).toEqual(
      []
    );
  }
  if (child.manifest.version !== 3 || fixture.capture.manifest.version !== 3)
    throw new Error('Expected v3 captures');
  expect(child.manifest.units).toEqual(fixture.capture.manifest.units);
  await verifyWorkflowSourceUnits(child.anchor, ['installed/acme.broken']);
});

for (const copyFault of ['unreadable', 'tampered']) {
  test(`an inherited ${copyFault} fault during copying removes payloads and retains the original inventory`, async () => {
    await put(join(project, '.archon/workflows/healthy.yaml'), workflow('healthy', first));
    const fixture = await pausedRun();
    const brokenFile = join(fixture.capture.anchor.root, 'installed/acme.broken/run/run.yaml');
    let reads = 0;
    const fault = spyOn(fs, 'readFile').mockImplementation(
      new Proxy(originalRead, {
        apply(target, thisArg, args: Parameters<typeof originalRead>) {
          if (String(args[0]) === brokenFile && ++reads === 2) {
            if (copyFault === 'tampered') {
              return fs
                .writeFile(brokenFile, 'changed during copy')
                .then(() => Reflect.apply(target, thisArg, args));
            }
            return Promise.reject(
              Object.assign(new Error('read failed during copy'), {
                code: 'EACCES',
                syscall: 'open',
                path: brokenFile,
              })
            );
          }
          return Reflect.apply(target, thisArg, args);
        },
      })
    );
    try {
      const child = await captureWorkflowSource({
        sourceRoot: project,
        captureRoot: join(root, 'child-capture'),
        installedFrom: { kind: 'captured', anchor: fixture.capture.anchor },
      });
      expect(reads).toBe(2);
      await expect(fs.stat(join(child.anchor.root, 'installed/acme.broken'))).rejects.toMatchObject(
        {
          code: 'ENOENT',
        }
      );
      if (child.manifest.version !== 3 || fixture.capture.manifest.version !== 3)
        throw new Error('Expected v3 captures');
      expect(child.manifest.units.find(unit => unit.root === 'installed/acme.broken')).toEqual(
        fixture.capture.manifest.units.find(unit => unit.root === 'installed/acme.broken')
      );
      await expect(
        verifyWorkflowSourceUnits(child.anchor, ['installed/acme.broken'])
      ).rejects.toBeInstanceOf(WorkflowSourceUnavailableError);
    } finally {
      fault.mockRestore();
    }
  });
}

test('include command scans retain source recovery when a verified resource disappears during lookup', async () => {
  await put(join(project, '.archon/workflows/healthy.yaml'), workflow('healthy', first));
  await put(join(root, 'home/commands/check.md'), 'required-resource');
  const fixture = await pausedRun();
  const command = join(fixture.capture.anchor.root, 'global/commands/check.md');
  let reads = 0;
  const fault = spyOn(fs, 'readFile').mockImplementation(
    new Proxy(originalRead, {
      apply(target, thisArg, args: Parameters<typeof originalRead>) {
        if (String(args[0]) === command && ++reads === 2) {
          return fs.rm(command).then(() => Reflect.apply(target, thisArg, args));
        }
        return Reflect.apply(target, thisArg, args);
      },
    })
  );
  try {
    await expect(
      resolveCommandContentForScan(
        capturedSourceRoots(fixture.capture.anchor, 'healthy'),
        'check',
        {}
      )
    ).rejects.toBeInstanceOf(WorkflowSourceUnavailableError);
  } finally {
    fault.mockRestore();
  }
});

for (const dependency of [
  'script',
  'command',
  'loop-command',
  'composed-command',
  'nested-command',
]) {
  test(`resume ignores an unrelated workflow's ${dependency} dependency but refuses it when selected`, async () => {
    await install('broken', {
      'run/run.yaml': workflow('run', first),
      'run/scripts/check.ts': "console.log('unused');",
      'run/commands/check.md': 'unused command',
    });
    await put(
      join(project, '.archon/workflows/healthy.yaml'),
      workflow('healthy', `${first}\n${remaining}`)
    );
    await put(join(project, '.archon/scripts/check.ts'), "console.log('frozen-result');");
    const command = packScript('broken');
    const body =
      dependency === 'script'
        ? `  - id: use\n    script: ${command}\n    runtime: bun`
        : dependency === 'loop-command'
          ? `  - id: use\n    loop:\n      command: ${command}\n      until: DONE\n      max_iterations: 1`
          : `  - id: use\n    command: ${command}`;
    await put(join(project, '.archon/workflows/block.yaml'), workflow('block', body));
    const include =
      dependency === 'composed-command'
        ? '  - id: use\n    include: block\n    depends_on: [first]\n    fan_out:\n      items: $first.output\n      as: item\n      max_parallel: 1\n      join: all_success'
        : dependency === 'nested-command'
          ? '  - id: group\n    loop_group:\n      until: DONE\n      max_iterations: 1\n      nodes:\n        - id: use\n          include: block'
          : '  - id: use\n    include: block';
    await put(
      join(project, '.archon/workflows/other.yaml'),
      workflow('other', `${first}\n${include}`)
    );
    const fixture = await pausedRun();
    const fault = denyReads(join(fixture.capture.anchor.root, 'installed/acme.broken'));
    try {
      expect(await fixture.resume()).toMatchObject({ success: true });
      const outputs = (await fixture.store.getDagResumeSnapshot(fixture.run.id))
        .completedNodeOutputs;
      expect(outputs.get('remaining')?.output).toContain('frozen-result');
      await expect(
        discoverWorkflowsWithConfig(
          project,
          loadConfig,
          providerRegistry,
          capturedSourceRoots(fixture.capture.anchor, 'other')
        )
      ).rejects.toBeInstanceOf(WorkflowSourceUnavailableError);
      await expect(
        discoverWorkflowsWithConfig(
          project,
          loadConfig,
          providerRegistry,
          capturedSourceRoots(fixture.capture.anchor)
        )
      ).rejects.toBeInstanceOf(WorkflowSourceUnavailableError);
    } finally {
      fault.mockRestore();
    }
  });
}

test('project resume completes with an unreadable unrelated installed directory', async () => {
  await put(
    join(project, '.archon/workflows/healthy.yaml'),
    workflow('healthy', `${first}\n${remaining}`)
  );
  await put(join(project, '.archon/scripts/check.ts'), "console.log('frozen-directory-result');");
  const fixture = await pausedRun();
  await put(join(project, '.archon/scripts/check.ts'), "throw new Error('live source');");
  const blocked = join(fixture.capture.anchor.root, 'installed/acme.broken');
  const original = fs.readdir;
  const fault = spyOn(fs, 'readdir').mockImplementation(
    new Proxy(original, {
      apply(target, thisArg, args: Parameters<typeof original>) {
        if (String(args[0]).startsWith(blocked))
          return Promise.reject(
            Object.assign(new Error('persistent directory fault'), {
              code: 'EACCES',
              syscall: 'scandir',
              path: blocked,
            })
          );
        return Reflect.apply(target, thisArg, args);
      },
    })
  );
  try {
    expect(await fixture.resume()).toMatchObject({ success: true });
    expect(await fixture.store.getWorkflowRunStatus(fixture.run.id)).toBe('completed');
    const outputs = (await fixture.store.getDagResumeSnapshot(fixture.run.id)).completedNodeOutputs;
    expect(outputs.get('first')?.output).toBe('already-done');
    expect(outputs.get('remaining')?.output).toContain('frozen-directory-result');
    await expect(
      verifyWorkflowSourceUnits(fixture.capture.anchor, ['installed/acme.broken'])
    ).rejects.toBeInstanceOf(WorkflowSourceUnavailableError);
  } finally {
    fault.mockRestore();
  }
});

for (const mutation of ['entrypoint', 'name', 'missing-entrypoint']) {
  test(`live capture derives and validates the staged installed descriptor after the ${mutation} changes`, async () => {
    const live = packTreePath(join(root, 'home/plugins'), 'acme/broken', 'a'.repeat(40));
    const original = fs.copyFile;
    let changed = false;
    const fault = spyOn(fs, 'copyFile').mockImplementation(async (...args) => {
      if (!changed && String(args[0]).startsWith(live)) {
        changed = true;
        await put(
          join(live, 'archon-plugin.json'),
          JSON.stringify({
            schemaVersion: 1,
            kind: 'workflow-pack',
            name: mutation === 'name' ? 'renamed' : 'broken',
            description: 'Changed during capture',
            entrypoints: {
              changed: mutation === 'missing-entrypoint' ? 'missing/missing.yaml' : 'run/run.yaml',
            },
          })
        );
      }
      return original(...args);
    });
    try {
      const capture = captureWorkflowSource({
        sourceRoot: project,
        captureRoot: join(root, 'capture'),
      });
      if (mutation !== 'entrypoint') {
        await expect(capture).rejects.toThrow();
      } else {
        const result = await capture;
        if (result.manifest.version !== 3) throw new Error('Expected v3');
        expect(result.manifest.installed_plugins[0].manifest.entrypoints).toEqual({
          changed: 'run/run.yaml',
        });
        const catalog = await discoverWorkflowsWithConfig(
          project,
          loadConfig,
          providerRegistry,
          capturedSourceRoots(result.anchor, 'acme/broken:changed')
        );
        expect(catalog.workflows.map(entry => entry.workflow.name)).toEqual([
          'acme/broken:changed',
        ]);
      }
      expect(changed).toBe(true);
    } finally {
      fault.mockRestore();
    }
  });
}

for (const scope of ['project', 'global', 'bundled', 'installed'] as const) {
  test(`selected ${scope} composition retains non-pausing workflow children without reading child resources`, async () => {
    await install('broken', {
      'run/run.yaml': workflow('run', first),
      'run/scripts/check.ts': "console.log('child-only');",
      'run/commands/check.md': 'child-only command',
    });
    const files = {
      'run/run.yaml': workflow(
        'run',
        '  - id: composed\n    include: body\n    fan_out:\n      items: $input.items\n      as: item\n      join: all_success'
      ),
      'body/body.yaml': workflow('body', '  - id: child\n    workflow: leaf'),
      'leaf/leaf.yaml': workflow(
        'leaf',
        `  - id: use\n    script: ${packScript('broken')}\n    runtime: bun\n  - id: block\n    include: leaf-block\n    depends_on: [use]`
      ),
      'leaf-block/leaf-block.yaml': workflow(
        'leaf-block',
        `  - id: done\n    command: ${packScript('broken')}`
      ),
    };
    if (scope === 'installed')
      await install('healthy', files, { run: 'run/run.yaml', leaf: 'leaf/leaf.yaml' });
    else {
      const directory = {
        project: join(project, '.archon/workflows'),
        global: join(root, 'home/workflows'),
        bundled: join(bundleRoot, 'fixture'),
      }[scope];
      for (const [path, content] of Object.entries(files))
        await put(join(directory, path), content);
    }
    if (scope === 'bundled')
      spyOn(bundleInventory, 'readBundleIndex').mockResolvedValue(['fixture']);
    try {
      const capture = await captureWorkflowSource({
        sourceRoot: project,
        captureRoot: join(root, 'composition'),
      });
      const name = scope === 'installed' ? 'acme/healthy:run' : 'run';
      const body = scope === 'installed' ? 'acme/healthy:body' : 'body';
      const roots = capturedSourceRoots(capture.anchor, name);
      const fault = denyReads(join(capture.anchor.root, 'installed/acme.broken'));
      try {
        const catalog = await discoverWorkflowsWithConfig(
          project,
          loadConfig,
          providerRegistry,
          roots
        );
        expect(catalog.errors).toEqual([]);
        expect(catalog.workflows.some(entry => entry.workflow.name === name)).toBe(true);
        const resolved = await resolveFanOutChildDefinition(
          {
            loadConfig,
            providers: providerRegistry,
            store: await createFileWorkflowStore({ root: join(root, 'compose-store') }),
            getAgentProvider: () => {
              throw new Error('No agent expected');
            },
          },
          project,
          body,
          roots
        );
        if ('unresolved' in resolved) throw new Error(resolved.unresolved);
        expect(collectComposedSuspensionPaths(resolved.definition, resolved.definitions)).toEqual(
          []
        );
      } finally {
        fault.mockRestore();
      }
    } finally {
      if (scope === 'bundled') {
        spyOn(bundleInventory, 'readBundleIndex').mockResolvedValue([]);
        for (const path of Object.keys(files)) await fs.rm(join(bundleRoot, 'fixture', path));
      }
    }
  });
}

test('resume resolves a bare project script despite an unreadable global script unit', async () => {
  await put(
    join(project, '.archon/workflows/healthy.yaml'),
    workflow('healthy', `${first}\n${remaining}`)
  );
  await put(join(project, '.archon/scripts/check.ts'), "console.log('frozen-local');");
  await put(join(root, 'home/scripts/check.ts'), "throw new Error('shadowed');");
  const fixture = await pausedRun();
  await put(join(project, '.archon/scripts/check.ts'), "throw new Error('live');");
  const fault = denyReads(join(fixture.capture.anchor.root, 'global'));
  try {
    expect(await fixture.resume()).toMatchObject({ success: true });
    expect(
      (await fixture.store.getDagResumeSnapshot(fixture.run.id)).completedNodeOutputs.get(
        'remaining'
      )?.output
    ).toContain('frozen-local');
  } finally {
    fault.mockRestore();
  }
});

for (const kind of ['script', 'command'] as const) {
  for (const owner of ['project', 'global'] as const) {
    test(`bare ${kind} selects authenticated ${owner} precedence and refuses its read fault`, async () => {
      const filename = kind === 'script' ? 'check.ts' : 'check.md';
      const content = kind === 'script' ? "console.log('frozen');" : 'frozen command';
      await put(join(root, 'home', `${kind}s`, 'group', filename), content);
      if (owner === 'project')
        await put(join(project, '.archon', `${kind}s`, 'group', filename), content);
      const capture = await captureWorkflowSource({
        sourceRoot: project,
        captureRoot: join(root, 'lookup'),
      });
      const roots = capturedSourceRoots(capture.anchor);
      const lookup = () =>
        kind === 'script'
          ? discoverScriptsForCwd(project, roots, new Set(['check']))
          : loadCommandPrompt({ loadConfig }, project, 'check', undefined, roots);
      const unrelated = denyReads(
        join(capture.anchor.root, owner === 'project' ? 'global' : 'installed')
      );
      try {
        const result = await lookup();
        if (result instanceof Map) expect(result.get('check')?.path).toContain(`/${owner}/`);
        else expect(result).toEqual({ success: true, content });
        if (kind === 'command')
          expect(await resolveCommandContentForScan(roots, 'check', {})).toBe(content);
      } finally {
        unrelated.mockRestore();
      }
      const required = denyReads(join(capture.anchor.root, owner));
      try {
        await expect(lookup()).rejects.toBeInstanceOf(WorkflowSourceUnavailableError);
      } finally {
        required.mockRestore();
      }
    });
  }
}

for (const state of ['pending', 'completed'] as const) {
  for (const dependency of [
    'script',
    'command',
    'loop-command',
    'recursive-command',
    'group-command',
  ] as const) {
    test(`${state} ordinary child ignores obsolete ${dependency} resources on parent resume`, async () => {
      await install('broken', {
        'run/run.yaml': workflow('run', first),
        'run/scripts/check.ts': "console.log('obsolete');",
        'run/commands/check.md': 'obsolete command',
      });
      await put(
        join(project, '.archon/workflows/healthy.yaml'),
        workflow('healthy', `${first}\n  - id: call\n    workflow: child\n    depends_on: [first]`)
      );
      const resource = packScript('broken');
      const body =
        dependency === 'script'
          ? `  - id: use\n    script: ${resource}\n    runtime: bun`
          : dependency === 'loop-command'
            ? `  - id: use\n    loop:\n      command: ${resource}\n      until: DONE\n      max_iterations: 1`
            : `  - id: use\n    command: ${resource}`;
      await put(join(project, '.archon/workflows/block.yaml'), workflow('block', body));
      await put(
        join(project, '.archon/workflows/middle.yaml'),
        workflow('middle', '  - id: inner\n    include: block')
      );
      const child =
        dependency === 'script'
          ? body
          : dependency === 'group-command'
            ? '  - id: group\n    loop_group:\n      until: DONE\n      max_iterations: 1\n      nodes:\n        - id: nested\n          include: middle\n        - id: done\n          depends_on: [nested]\n          bash: echo DONE'
            : `  - id: nested\n    include: ${dependency === 'recursive-command' ? 'middle' : 'block'}`;
      await put(join(project, '.archon/workflows/child.yaml'), workflow('child', child));
      const fixture = await pausedRun();
      const childCatalog = await discoverWorkflowsWithConfig(
        project,
        loadConfig,
        providerRegistry,
        capturedSourceRoots(fixture.capture.anchor, 'child')
      );
      expect(childCatalog.errors).toEqual([]);
      expect(childCatalog.workflows.some(entry => entry.workflow.name === 'child')).toBe(true);
      if (state === 'completed') {
        await fixture.store.persistWorkflowEvent({
          workflow_run_id: fixture.run.id,
          event_type: 'node_completed',
          step_name: 'call',
          data: { node_output: 'completed-child' },
        });
      }
      await put(
        join(project, '.archon/workflows/child.yaml'),
        workflow(
          'child',
          `  - id: repaired\n    bash: ${state === 'pending' ? 'echo repaired-child' : 'exit 96'}`
        )
      );
      const fault = denyReads(join(fixture.capture.anchor.root, 'installed/acme.broken'));
      try {
        expect(await fixture.resume()).toMatchObject({ success: true });
        expect(await fixture.store.getWorkflowRunStatus(fixture.run.id)).toBe('completed');
        const outputs = (await fixture.store.getDagResumeSnapshot(fixture.run.id))
          .completedNodeOutputs;
        expect(outputs.get('call')?.output).toContain(
          state === 'pending' ? 'repaired-child' : 'completed-child'
        );
      } finally {
        fault.mockRestore();
      }
    });
  }
}

for (const scope of ['global', 'bundled'] as const) {
  for (const kind of ['script', 'command'] as const) {
    test(`${scope} resume ignores an unreadable project with only ${kind}s`, async () => {
      const filename = kind === 'script' ? 'unused.ts' : 'unused.md';
      await put(join(project, '.archon', `${kind}s`, filename), 'unused');
      const directory =
        scope === 'global' ? join(root, 'home/workflows') : join(bundleRoot, 'namespace');
      const path = join(directory, 'healthy/healthy.yaml');
      await put(
        path,
        workflow(
          'healthy',
          `${first}\n  - id: remaining\n    bash: echo frozen-${scope}\n    depends_on: [first]`
        )
      );
      if (scope === 'bundled')
        spyOn(bundleInventory, 'readBundleIndex').mockResolvedValue(['namespace']);
      try {
        const fixture = await pausedRun();
        const fault = denyReads(join(fixture.capture.anchor.root, 'project'));
        try {
          expect(await fixture.resume()).toMatchObject({ success: true });
          expect(await fixture.store.getWorkflowRunStatus(fixture.run.id)).toBe('completed');
          const roots = capturedSourceRoots(fixture.capture.anchor, 'healthy');
          const lookup = () =>
            kind === 'script'
              ? discoverScriptsForCwd(project, roots, new Set(['unused']))
              : loadCommandPrompt({ loadConfig }, project, 'unused', undefined, roots);
          await expect(lookup()).rejects.toBeInstanceOf(WorkflowSourceUnavailableError);
        } finally {
          fault.mockRestore();
        }
      } finally {
        if (scope === 'bundled') {
          spyOn(bundleInventory, 'readBundleIndex').mockResolvedValue([]);
          await fs.rm(path);
        }
      }
    });
  }
}

test('selected composition still rejects a suspension reached through a child include', async () => {
  const files = {
    'run.yaml': workflow(
      'run',
      '  - id: fan\n    include: body\n    fan_out:\n      items: $input.items\n      as: item\n      join: all_success'
    ),
    'body.yaml': workflow('body', '  - id: call\n    workflow: child'),
    'child.yaml': workflow('child', '  - id: block\n    include: pausing'),
    'pausing.yaml': workflow('pausing', '  - id: pause\n    approval:\n      message: Continue?'),
  };
  for (const [path, content] of Object.entries(files))
    await put(join(project, '.archon/workflows', path), content);
  const capture = await captureWorkflowSource({
    sourceRoot: project,
    captureRoot: join(root, 'proof'),
  });
  const roots = capturedSourceRoots(capture.anchor, 'run');
  const catalog = await discoverWorkflowsWithConfig(project, loadConfig, providerRegistry, roots);
  expect(catalog.workflows.some(entry => entry.workflow.name === 'run')).toBe(false);
  expect(
    catalog.errors.some(error => error.error.includes('unsupported suspension-capable path'))
  ).toBe(true);
  const resolved = await resolveFanOutChildDefinition(
    {
      loadConfig,
      providers: providerRegistry,
      store: await createFileWorkflowStore({ root: join(root, 'proof-store') }),
      getAgentProvider: () => {
        throw new Error('No agent expected');
      },
    },
    project,
    'body',
    roots
  );
  if ('unresolved' in resolved) throw new Error(resolved.unresolved);
  expect(collectComposedSuspensionPaths(resolved.definition, resolved.definitions)).toEqual([
    { id: 'pause', reason: 'approval gate' },
  ]);
});
