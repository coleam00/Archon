// @archon-test-isolated
import { afterEach, expect, it, spyOn } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { execFileAsync } from '@archon/git';
import * as git from '@archon/git/ignored-files';
import { providerRegistry } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { discoverWorkflows } from './workflow-discovery';
import { liveSourceRoots, capturedSourceRoots } from './workflow-source';
import { collectIgnoredSourceWarnings } from './workflow-discovery/ignored-files';
import type { DiscoveryContext } from './workflow-discovery/context';

registerBuiltinProviders();
let root: string;
afterEach(async () => {
  if (root) await removeTempTree(root);
});
async function put(path: string, content: string): Promise<void> {
  const full = join(root, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
}
async function setup() {
  root = await mkdtemp(join(tmpdir(), 'workflow-ignored-'));
  await execFileAsync('git', ['init', root]);
  return {
    ...liveSourceRoots(root),
    globalWorkflows: join(root, 'global/workflows'),
    globalCommands: join(root, 'global/commands'),
    globalScripts: join(root, 'global/scripts'),
    installed: { kind: 'receipts' as const, pluginsDir: join(root, 'plugins') },
  };
}
const workflow = (name: string, nodes = '  - id: run\n    bash: echo ok\n') =>
  `name: ${name}\ndescription: Example\nnodes:\n${nodes}`;

it('reports ignored YAML without removing it, and stays silent for visible or tracked files', async () => {
  const roots = await setup();
  await put('.gitignore', 'build/\n');
  await put('.archon/workflows/build/x.yaml', workflow('x'));
  const options = {
    providers: providerRegistry,
    loadDefaults: false,
    sourceRoots: roots,
    gitIgnoreRoot: root,
  };
  const result = await discoverWorkflows(root, options);
  expect(result.errors).toEqual([]);
  expect(result.workflows.map(w => w.workflow.name)).toEqual(['x']);
  expect(result.sourceWarnings).toEqual([
    'Git ignores ".archon/workflows/build/x.yaml" (workflows: "x"); it may be missing from other checkouts.',
  ]);
  expect(
    (await discoverWorkflows(root, { ...options, gitIgnoreRoot: undefined })).sourceWarnings
  ).toBeUndefined();
  await execFileAsync('git', ['-C', root, 'add', '-f', '.archon/workflows/build/x.yaml']);
  expect((await discoverWorkflows(root, options)).sourceWarnings).toBeUndefined();
  await put('.archon/workflows/visible.yaml', workflow('visible'));
  expect((await discoverWorkflows(root, options)).sourceWarnings).toBeUndefined();
});

it('checks resolved named dependencies before composition erases command references', async () => {
  const roots = await setup();
  await put('.gitignore', '*.md\n*.ts\n');
  await put('.archon/commands/check.md', 'Check it.');
  await put('custom/extra.md', 'Extra check.');
  await put('.archon/scripts/report.ts', 'console.log("ok");');
  await put(
    '.archon/workflows/block.yaml',
    workflow('block', '  - id: check\n    command: check\n')
  );
  await put(
    '.archon/workflows/parent.yaml',
    workflow('parent', '  - id: block\n    include: block\n')
  );
  await put(
    '.archon/workflows/other.yaml',
    workflow(
      'other',
      '  - id: check\n    command: check\n  - id: extra\n    command: extra\n  - id: report\n    script: report\n    runtime: bun\n'
    )
  );
  await put(
    '.archon/workflows/pack/entry/entry.yaml',
    workflow(
      'pack-entry',
      '  - id: check\n    command: check\n  - id: report\n    script: shared\n    runtime: bun\n'
    )
  );
  await put('.archon/workflows/pack/entry/commands/check.md', 'Pack check.');
  await put('.archon/workflows/pack/.shared/scripts/shared.ts', 'console.log("ok");');
  const result = await discoverWorkflows(root, {
    providers: providerRegistry,
    loadDefaults: false,
    sourceRoots: roots,
    gitIgnoreRoot: root,
    commandFolder: 'custom',
  });
  expect(result.errors).toEqual([]);
  expect(result.workflows).toHaveLength(4);
  expect(result.sourceWarnings).toHaveLength(5);
  expect(result.sourceWarnings?.join('\n')).toContain(
    '".archon/commands/check.md" (workflows: "block", "other")'
  );
  for (const path of [
    'custom/extra.md',
    '.archon/scripts/report.ts',
    '.archon/workflows/pack/entry/commands/check.md',
    '.archon/workflows/pack/.shared/scripts/shared.ts',
  ]) {
    expect(result.sourceWarnings?.join('\n')).toContain(JSON.stringify(path));
  }
});

it('excludes global sources even inside the checkout, including project fallbacks', async () => {
  const roots = await setup();
  await put('.gitignore', 'global/\n');
  await put('global/workflows/global.yaml', workflow('global'));
  await put('global/commands/check.md', 'Check.');
  await put('global/scripts/report.ts', 'console.log("ok");');
  await put(
    '.archon/workflows/local.yaml',
    workflow(
      'local',
      '  - id: check\n    command: check\n  - id: report\n    script: report\n    runtime: bun\n  - id: inline\n    script: console.log("inline");\n    runtime: bun\n  - id: shell\n    bash: echo global/ignored\n'
    )
  );
  const result = await discoverWorkflows(root, {
    providers: providerRegistry,
    loadDefaults: false,
    sourceRoots: roots,
    gitIgnoreRoot: root,
  });
  expect(result.errors).toEqual([]);
  expect(result.workflows).toHaveLength(2);
  expect(result.sourceWarnings).toBeUndefined();
});

it('skips captured roots and makes Git failure observable without changing loaded workflows', async () => {
  const roots = await setup();
  await put('.archon/workflows/x.yaml', workflow('x'));
  const probe = spyOn(git, 'findIgnoredFiles').mockRejectedValue(new Error('probe failed'));
  try {
    const context: DiscoveryContext = {
      cwd: root,
      gitIgnoreRoot: root,
      roots: capturedSourceRoots({ root, digest: 'test', config: roots.config }),
      capture: undefined,
      commandScan: {},
      allErrors: [],
      providers: providerRegistry,
      configuredEnvNames: new Set(),
    };
    expect(await collectIgnoredSourceWarnings(context, [], new Map())).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
    const result = await discoverWorkflows(root, {
      providers: providerRegistry,
      loadDefaults: false,
      sourceRoots: roots,
      gitIgnoreRoot: root,
    });
    expect(result.errors).toEqual([]);
    expect(result.workflows).toHaveLength(1);
    expect(result.sourceWarnings).toEqual([
      'Could not check workflow source files against Git ignore rules.',
    ]);
  } finally {
    probe.mockRestore();
  }
});

it('collects commands and scripts inside loop groups and loop commands', async () => {
  const roots = await setup();
  await put('.gitignore', '*.md\n*.ts\n');
  await put('.archon/commands/check.md', 'Check.');
  await put('.archon/commands/repeat.md', 'Repeat.');
  await put('.archon/scripts/report.ts', 'console.log("ok");');
  await put(
    '.archon/workflows/nested.yaml',
    workflow(
      'nested',
      `  - id: group
    loop_group:
      until: done
      max_iterations: 1
      nodes:
        - id: check
          command: check
        - id: script
          script: report
          runtime: bun
  - id: repeat
    loop:
      command: repeat
      until: done
      max_iterations: 1
`
    )
  );
  const result = await discoverWorkflows(root, {
    providers: providerRegistry,
    loadDefaults: false,
    sourceRoots: roots,
    gitIgnoreRoot: root,
  });
  expect(result.errors).toEqual([]);
  expect(result.sourceWarnings).toHaveLength(3);
  for (const path of [
    '.archon/commands/check.md',
    '.archon/commands/repeat.md',
    '.archon/scripts/report.ts',
  ])
    expect(result.sourceWarnings?.join('\n')).toContain(JSON.stringify(path));
});

it('checks only the surviving project override and leaves non-repositories silent', async () => {
  const roots = await setup();
  await put('.gitignore', 'build/\nglobal/\n');
  await put('global/workflows/x.yaml', workflow('shadowed'));
  await put('.archon/workflows/build/x.yaml', workflow('project'));
  const options = {
    providers: providerRegistry,
    loadDefaults: false,
    sourceRoots: roots,
    gitIgnoreRoot: root,
  };
  const result = await discoverWorkflows(root, options);
  expect(result.errors).toEqual([]);
  expect(result.workflows.map(entry => entry.workflow.name)).toEqual(['project']);
  expect(result.sourceWarnings).toHaveLength(1);
  expect(result.sourceWarnings?.[0]).toContain('"project"');
  await removeTempTree(join(root, '.git'));
  expect((await discoverWorkflows(root, options)).sourceWarnings).toBeUndefined();
});

it('does not consider bundled or installed entries even when their files are inside the checkout', async () => {
  const roots = await setup();
  await put('.gitignore', '*.yaml\n');
  await put('.archon/workflows/x.yaml', workflow('x'));
  const loaded = await discoverWorkflows(root, {
    providers: providerRegistry,
    loadDefaults: false,
    sourceRoots: roots,
  });
  const parsed = {
    ...loaded.workflows[0].workflow,
    nodes: [...loaded.workflows[0].workflow.nodes],
  };
  const context: DiscoveryContext = {
    cwd: root,
    gitIgnoreRoot: root,
    roots,
    capture: undefined,
    commandScan: {},
    allErrors: [],
    providers: providerRegistry,
    configuredEnvNames: new Set(),
  };
  expect(
    await collectIgnoredSourceWarnings(
      context,
      (['bundled', 'installed'] as const).map(source => ({
        workflow: parsed,
        source,
        filePath: join(root, '.archon/workflows/x.yaml'),
        parseWarnings: [],
      })),
      new Map()
    )
  ).toEqual([]);
});

it('reports command inspection failures without rejecting a workflow or validating missing commands', async () => {
  const roots = await setup();
  await put('.archon/workflows/x.yaml', workflow('x', '  - id: check\n    command: missing\n'));
  const options = {
    providers: providerRegistry,
    loadDefaults: false,
    sourceRoots: roots,
    gitIgnoreRoot: root,
  };
  expect((await discoverWorkflows(root, options)).sourceWarnings).toBeUndefined();
  const scan = await import('./workflow-discovery/command-scan');
  const probe = spyOn(scan, 'resolveCommandSourceForScan').mockResolvedValue({
    content: {
      path: '.archon/commands',
      operation: 'inspect',
      message: 'Permission denied',
      cause: new Error('Permission denied'),
    },
  });
  try {
    const result = await discoverWorkflows(root, options);
    expect(result.workflows).toHaveLength(1);
    expect(result.errors).toEqual([]);
    expect(result.sourceWarnings).toEqual([
      'Could not check Git ignores for command "missing" in workflow "x".',
    ]);
  } finally {
    probe.mockRestore();
  }
});

it('excludes a project command resolved outside the Git checkout', async () => {
  const roots = await setup();
  const project = join(root, 'project');
  await put(
    'project/.archon/workflows/x.yaml',
    workflow('x', '  - id: check\n    command: check\n')
  );
  await put('project/.gitignore', '*.md\n');
  await put('shared/check.md', 'Check.');
  await execFileAsync('git', ['init', project]);
  const result = await discoverWorkflows(project, {
    providers: providerRegistry,
    loadDefaults: false,
    sourceRoots: { ...roots, project },
    gitIgnoreRoot: project,
    commandFolder: '../shared',
  });
  expect(result.errors).toEqual([]);
  expect(result.workflows).toHaveLength(1);
  expect(result.sourceWarnings).toBeUndefined();
});
