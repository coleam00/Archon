/**
 * `archon pack bindings` against a minimal fixture pack, discovered from a real project
 * folder: what it writes is read back with the schemas of the loaders that consume it.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubWebhookSourceConfigSchema } from '@archon/adapters/forge/github-source-plugin';
import { defaultPlatformPolicies } from '@archon/adapters/platform-policies';
import { setPlatformPolicies } from '@archon/core/platforms/registry';
import { removeTempTree } from '@archon/paths/test-utils';
import { packCommand, type PackBindingsOptions } from './pack';
import { timerTriggerConfigSchema } from './trigger';

const DECLARATION = `bindings:
  sweep:
    workflow: fixture-sweep
    resource: sweep
    capacity: 2
    overlap: skip
    isolation: { kind: worktree }
    schedule: { interval_seconds: 600 }
    inputs:
      repo_host: { repo: host }
      repo_path: { repo: path }
      sweep_binding: { binding: sweep }
      mode: fast
  after:
    workflow: fixture-sweep
    resource: after
    resource_scope: host
    overlap: queue
    schedule: { interval_seconds: 60 }
    inputs:
      sweep_binding: { binding: sweep }
  opened:
    workflow: fixture-sweep
    resource: opened
    overlap: queue
    event:
      kind: issue.lifecycle
      actions: [opened]
    inputs:
      number: { event: subject.number }
      mode: slow
`;

let root: string;
let cwd: string;
let out: string;
let logSpy: ReturnType<typeof spyOn>;
const originalArchonHome = process.env.ARCHON_HOME;

async function writePack(declaration: string): Promise<void> {
  const pack = join(cwd, '.archon', 'workflows', 'fixture');
  // The fixture pack is the whole subject: keep the bundled packs out of discovery.
  await mkdir(join(cwd, '.archon'), { recursive: true });
  await writeFile(
    join(cwd, '.archon', 'config.yaml'),
    'defaults:\n  loadDefaultWorkflows: false\n  loadDefaultCommands: false\n'
  );
  await mkdir(join(pack, '.pack'), { recursive: true });
  await mkdir(join(pack, 'fixture-sweep'), { recursive: true });
  await writeFile(join(pack, '.pack', 'pack.yaml'), declaration);
  await writeFile(
    join(pack, 'fixture-sweep', 'fixture-sweep.yaml'),
    'name: fixture-sweep\ndescription: d\nnodes:\n  - id: a\n    bash: echo hi\n'
  );
}

function options(extra: Partial<PackBindingsOptions> = {}): PackBindingsOptions {
  return {
    cwd,
    repo: 'git.example.com/acme/widgets',
    host: 'host-1',
    runAs: 'user-1',
    out,
    ...extra,
  };
}

async function readJson(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(out, name), 'utf8')) as unknown;
}

beforeEach(async () => {
  // Loading the project's config needs the policies a CLI route installs.
  setPlatformPolicies(defaultPlatformPolicies);
  root = await mkdtemp(join(tmpdir(), 'pack-bindings-'));
  cwd = join(root, 'checkout');
  out = join(root, 'bindings');
  process.env.ARCHON_HOME = join(root, 'home');
  logSpy = spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  logSpy.mockRestore();
  await removeTempTree(root);
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
});

describe('archon pack bindings', () => {
  it('writes a timer binding the timer loader accepts, with sibling references resolved', async () => {
    await writePack(DECLARATION);
    await packCommand('bindings', ['fixture'], options({ only: 'sweep,after' }));

    expect((await readdir(out)).sort()).toEqual([
      'acme-widgets-after.json',
      'acme-widgets-sweep.json',
    ]);
    const sweepPath = join(out, 'acme-widgets-sweep.json');
    expect(timerTriggerConfigSchema.parse(await readJson('acme-widgets-sweep.json'))).toEqual({
      version: 1,
      sourceInstanceId: 'acme-widgets-sweep',
      binding: {
        bindingId: 'acme-widgets-sweep',
        bindingRevision: null,
        hostId: 'host-1',
        runAsUserId: 'user-1',
        resource: 'fixture:git.example.com/acme/widgets:sweep',
        capacity: 2,
        overlap: 'skip',
        launch: {
          cwd,
          workflowName: 'fixture-sweep',
          inputs: {
            repo_host: 'git.example.com',
            repo_path: 'acme/widgets',
            sweep_binding: sweepPath,
            mode: 'fast',
          },
          isolation: { kind: 'worktree' },
        },
      },
      schedule: { intervalSeconds: 600, runAtLoad: false },
    });
    const after = timerTriggerConfigSchema.parse(await readJson('acme-widgets-after.json'));
    expect(after.binding.resource).toBe('fixture:host-1:after');
    expect(after.binding.launch.inputs).toEqual({ sweep_binding: sweepPath });
    expect(logSpy.mock.calls.flat().join('\n')).toContain(
      `archon trigger schedule install --config ${sweepPath}`
    );
  });

  it('writes an event binding the GitHub source plugin accepts', async () => {
    await writePack(DECLARATION);
    await packCommand(
      'bindings',
      ['fixture'],
      options({ repo: 'github.com/acme/widgets', only: 'opened' })
    );

    const binding = await readJson('acme-widgets-opened.json');
    const config = githubWebhookSourceConfigSchema.parse({
      version: 1,
      webhookSecretEnv: 'WEBHOOK_SECRET',
      host: 'github.com',
      bindings: [binding],
    });
    expect(config.bindings[0]).toMatchObject({
      bindingId: 'acme-widgets-opened',
      resource: 'fixture:github.com/acme/widgets:opened',
      launch: { workflowName: 'fixture-sweep', inputs: { mode: 'slow' } },
      selector: {
        kind: 'issue.lifecycle',
        actions: ['opened'],
        repository: { host: 'github.com', path: 'acme/widgets' },
      },
      inputMapping: { number: { source: 'field', field: 'subject.number' } },
    });
  });

  it('refuses a declaration that references an unknown sibling, naming the file', async () => {
    await writePack(DECLARATION.replace('{ binding: sweep }', '{ binding: missing }'));
    const run = packCommand('bindings', ['fixture'], options({ only: 'sweep' }));
    await expect(run).rejects.toThrow("names unknown binding 'missing'");
    await expect(run).rejects.toThrow('fixture/.pack/pack.yaml');
  });

  it('refuses to leave out a sibling whose file a selected binding names', async () => {
    await writePack(DECLARATION);
    await expect(packCommand('bindings', ['fixture'], options({ only: 'after' }))).rejects.toThrow(
      "Add 'sweep' to --only"
    );
    // Once the sibling's file exists, the reference has something to name.
    await packCommand('bindings', ['fixture'], options({ only: 'sweep' }));
    await packCommand('bindings', ['fixture'], options({ only: 'after' }));
    expect((await readdir(out)).length).toBe(2);
  });

  it('refuses to overwrite an existing file unless forced, and writes none of the set', async () => {
    await writePack(DECLARATION);
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'acme-widgets-after.json'), 'mine');

    await expect(
      packCommand('bindings', ['fixture'], options({ only: 'sweep,after' }))
    ).rejects.toThrow('Refusing to overwrite');
    expect(await readdir(out)).toEqual(['acme-widgets-after.json']);
    expect(await readFile(join(out, 'acme-widgets-after.json'), 'utf8')).toBe('mine');

    await packCommand('bindings', ['fixture'], options({ only: 'sweep,after', force: true }));
    expect(
      timerTriggerConfigSchema.safeParse(await readJson('acme-widgets-after.json')).success
    ).toBe(true);
  });

  it.each([
    [{ only: 'nope' }, "--only names 'nope'"],
    [{ repo: 'acme/widgets' }, '--repo must be <host>/<owner>/<name>'],
    [{ out: undefined }, 'Usage: archon pack bindings'],
  ])('refuses %p', async (extra, reason) => {
    await writePack(DECLARATION);
    await expect(packCommand('bindings', ['fixture'], options(extra))).rejects.toThrow(reason);
  });

  it('refuses a pack that is not found or declares no bindings', async () => {
    await writePack('inputs:\n  tone: {}\n');
    await expect(packCommand('bindings', ['absent'], options())).rejects.toThrow(
      "No workflow pack 'absent'"
    );
    await expect(packCommand('bindings', ['fixture'], options())).rejects.toThrow(
      "Pack 'fixture' declares no bindings"
    );
  });
});
