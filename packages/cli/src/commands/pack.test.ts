/**
 * `archon pack bindings` against a minimal fixture pack, discovered from a real project
 * folder: what it writes is read back with the schemas of the loaders that consume it.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { githubWebhookSourceConfigSchema } from '@archon/adapters/forge/github/source-config';
import { defaultPlatformPolicies } from '@archon/adapters/platform-policies';
import { setPlatformPolicies } from '@archon/core/platforms/registry';
import { readRunEndedBindings } from '@archon/core/workflows/run-ended';
import { FileStoreUnsupportedError } from '@archon/workflows/file-store';
import { removeTempTree } from '@archon/paths/test-utils';
import { packCommand, type PackBindingsOptions } from './pack';
import { triggerConfigSchema } from '@archon/workflows/schemas/resource-start';

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
  follow-up:
    workflow: fixture-sweep
    resource: follow-up
    overlap: queue
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
const originalDefaultAssistant = process.env.DEFAULT_AI_ASSISTANT;

// `fixture-plan` ends with an outcome; `build` starts `fixture-build` from it.
const RUN_ENDED_DECLARATION = `bindings:
  build:
    workflow: fixture-build
    resource: build
    capacity: 2
    overlap: queue
    isolation: { kind: in-place }
    run_ended: { workflow: fixture-plan, outcome: [planned, blocked] }
    inputs:
      plan: { result: /plan }
      issue: { input: issue }
      mode: fast
`;

const PLAN_WORKFLOW = `name: fixture-plan
description: d
inputs:
  issue: { required: true }
returns: { node: decide, outcome: outcome }
nodes:
  - id: decide
    bash: echo '{"outcome":"planned","plan":"p"}'
    output_format:
      type: object
      properties:
        outcome: { type: string, enum: [planned, blocked] }
        plan: { type: string }
      required: [outcome, plan]
`;

const BUILD_WORKFLOW = `name: fixture-build
description: d
inputs:
  plan: { required: true }
  issue: { required: true }
  mode: {}
nodes:
  - id: a
    bash: echo hi
`;

async function writeWorkflow(packDir: string, name: string, body: string): Promise<void> {
  await mkdir(join(packDir, name), { recursive: true });
  await writeFile(join(packDir, name, `${name}.yaml`), body);
}

async function writePack(declaration: string, dir: string = cwd): Promise<void> {
  const pack = join(dir, '.archon', 'workflows', 'fixture');
  // The fixture pack is the whole subject: keep the bundled packs out of discovery.
  await mkdir(join(dir, '.archon'), { recursive: true });
  await writeFile(
    join(dir, '.archon', 'config.yaml'),
    'defaults:\n  loadDefaultWorkflows: false\n  loadDefaultCommands: false\n'
  );
  await mkdir(join(pack, '.pack'), { recursive: true });
  await writeFile(join(pack, '.pack', 'pack.yaml'), declaration);
  await writeWorkflow(
    pack,
    'fixture-sweep',
    'name: fixture-sweep\ndescription: d\nnodes:\n  - id: a\n    bash: echo hi\n'
  );
  await writeWorkflow(pack, 'fixture-plan', PLAN_WORKFLOW);
  await writeWorkflow(pack, 'fixture-build', BUILD_WORKFLOW);
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

/** The one written file for a binding id; its name carries a digest of the identity. */
async function fileFor(id: string): Promise<string> {
  const [file, ...others] = (await readdir(out)).filter(name => name.includes(`-${id}-`));
  if (file === undefined || others.length > 0) throw new Error(`expected one file for ${id}`);
  return file;
}

beforeEach(async () => {
  // Loading the project's config needs the policies a CLI route installs.
  setPlatformPolicies(defaultPlatformPolicies);
  root = await mkdtemp(join(tmpdir(), 'pack-bindings-'));
  cwd = join(root, 'checkout');
  // A space in the path: the printed commands must still pass it as one argument.
  out = join(root, 'binding files');
  process.env.ARCHON_HOME = join(root, 'home');
  // A shell's provider default would make config loading require a provider
  // this test never registers. An empty value counts as unset. The hostile
  // value first stands in for a developer's shell: CI leaves the key unset, so
  // without it CI would stay green if the clear below were removed.
  process.env.DEFAULT_AI_ASSISTANT = 'claude';
  process.env.DEFAULT_AI_ASSISTANT = '';
  logSpy = spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  logSpy.mockRestore();
  await removeTempTree(root);
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
  if (originalDefaultAssistant === undefined) delete process.env.DEFAULT_AI_ASSISTANT;
  else process.env.DEFAULT_AI_ASSISTANT = originalDefaultAssistant;
});

describe('archon pack bindings', () => {
  it('writes a timer binding the timer loader accepts, with sibling references resolved', async () => {
    await writePack(DECLARATION);
    await packCommand('bindings', ['fixture'], options({ only: 'sweep,after' }));

    expect((await readdir(out)).length).toBe(2);
    const sweepFile = await fileFor('sweep');
    const sweepName = sweepFile.replace(/\.json$/, '');
    const sweepPath = join(out, sweepFile);
    expect(triggerConfigSchema.parse(await readJson(sweepFile))).toEqual({
      version: 1,
      sourceInstanceId: sweepName,
      binding: {
        bindingId: sweepName,
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
    const after = triggerConfigSchema.parse(await readJson(await fileFor('after')));
    expect(after.binding.resource).toBe('fixture:host-1:after');
    expect(after.binding.launch.inputs).toEqual({ sweep_binding: sweepPath });
    const printed = logSpy.mock.calls.flat().join('\n');
    expect(printed).toContain(`archon trigger fire --config '${sweepPath}'`);
    expect(printed).toContain(`archon trigger schedule install --config '${sweepPath}'`);
  });

  it('writes a fire-only binding as a trigger fire file with no schedule', async () => {
    await writePack(DECLARATION);
    await packCommand('bindings', ['fixture'], options({ only: 'follow-up' }));

    const file = await fileFor('follow-up');
    const config = triggerConfigSchema.parse(await readJson(file));
    expect(config.schedule).toBeUndefined();
    expect(config.binding.resource).toBe('fixture:git.example.com/acme/widgets:follow-up');
    const printed = logSpy.mock.calls.flat().join('\n');
    expect(printed).toContain('Fire-only bindings');
    expect(printed).toContain(`archon trigger fire --config '${join(out, file)}'`);
    expect(printed).not.toContain('schedule install');
  });

  it('writes an event binding the GitHub source plugin accepts', async () => {
    await writePack(DECLARATION);
    await packCommand(
      'bindings',
      ['fixture'],
      options({ repo: 'github.com/acme/widgets', only: 'opened' })
    );

    const file = await fileFor('opened');
    const binding = await readJson(file);
    const config = githubWebhookSourceConfigSchema.parse({
      version: 1,
      webhookSecretEnv: 'WEBHOOK_SECRET',
      host: 'github.com',
      bindings: [binding],
    });
    expect(config.bindings[0]).toMatchObject({
      bindingId: file.replace(/\.json$/, ''),
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

  it('refuses an event binding for a host the source plugin does not read, writing nothing', async () => {
    await writePack(DECLARATION);
    await expect(packCommand('bindings', ['fixture'], options())).rejects.toThrow(
      "Binding 'opened' does not generate a valid GitHub source plugin binding"
    );
    await expect(readdir(out)).rejects.toThrow();
  });

  it('gives distinct repositories distinct binding identities in one directory', async () => {
    await writePack(DECLARATION);
    const ids = new Set<string>();
    for (const repo of ['git.example.com/a-b/c', 'git.example.com/a/b-c', 'other.example/a/b-c']) {
      await packCommand('bindings', ['fixture'], options({ repo, only: 'sweep' }));
    }
    const files = await readdir(out);
    for (const file of files) {
      const config = triggerConfigSchema.parse(await readJson(file));
      ids.add(config.binding.bindingId).add(config.sourceInstanceId);
    }
    expect(files.length).toBe(3);
    expect(ids.size).toBe(3);
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
    await packCommand('bindings', ['fixture'], options({ only: 'sweep' }));
    const sweep = await fileFor('sweep');
    await writeFile(join(out, sweep), 'mine');

    await expect(
      packCommand('bindings', ['fixture'], options({ only: 'sweep,after' }))
    ).rejects.toThrow('Refusing to overwrite');
    expect(await readdir(out)).toEqual([sweep]);
    expect(await readFile(join(out, sweep), 'utf8')).toBe('mine');

    await packCommand('bindings', ['fixture'], options({ only: 'sweep,after', force: true }));
    expect(triggerConfigSchema.safeParse(await readJson(sweep)).success).toBe(true);
  });

  it.each([
    [{ only: 'nope' }, "--only names 'nope'"],
    [{ repo: 'acme/widgets' }, '--repo must be <host>/<owner>/<name>'],
    [{ out: undefined }, 'Usage: archon pack bindings'],
    [{ host: undefined }, 'Usage: archon pack bindings'],
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

describe('archon pack bindings: run-ended', () => {
  it('writes one trigger file per outcome to --out, mapping inputs from the ended run, and activates none', async () => {
    const source = join(root, 'pack source');
    const runConfig = join(root, 'run.yaml');
    await writeFile(runConfig, 'assistants: {}\n');
    await writePack(RUN_ENDED_DECLARATION, source);
    await mkdir(cwd, { recursive: true });
    await packCommand(
      'bindings',
      ['fixture'],
      options({ config: runConfig, workflowSource: source })
    );

    expect(existsSync(join(root, 'home', 'triggers'))).toBe(false);
    const bindings = await readRunEndedBindings(out);
    const printed = logSpy.mock.calls.flat().join('\n');
    for (const entry of bindings) expect(printed).toContain(`archon trigger add '${entry.file}'`);
    for (const entry of bindings) {
      const name = basename(entry.file, '.json');
      expect(entry.sourceInstanceId).toBe(name);
      expect(entry.binding).toEqual({
        bindingId: name,
        bindingRevision: null,
        hostId: 'host-1',
        runAsUserId: 'user-1',
        resource: 'fixture:git.example.com/acme/widgets:build',
        capacity: 2,
        overlap: 'queue',
        launch: {
          cwd,
          workflowName: 'fixture-build',
          inputs: { mode: 'fast' },
          discoveryCwd: source,
          configSource: runConfig,
          isolation: { kind: 'in-place' },
        },
      });
      expect(entry.runEnded).toEqual({
        workflowName: 'fixture-plan',
        outcome: entry.runEnded.outcome,
        inputs: { plan: { result: '/plan' }, issue: { input: 'issue' } },
      });
    }
  });

  it.each([
    [
      'an ended workflow the pack lacks',
      RUN_ENDED_DECLARATION.replace('workflow: fixture-plan', 'workflow: absent'),
      "names workflow 'absent'",
    ],
    [
      'an outcome the ended workflow does not declare',
      RUN_ENDED_DECLARATION.replace('[planned, blocked]', '[planned, shipped]'),
      "outcome 'shipped' is not one",
    ],
    [
      'an input the ended workflow does not declare',
      RUN_ENDED_DECLARATION.replace('{ input: issue }', '{ input: title }'),
      "reads 'title'",
    ],
    [
      'a binding that starts the workflow whose end fires it',
      RUN_ENDED_DECLARATION.replace('workflow: fixture-build', 'workflow: fixture-plan'),
      'the workflow whose end fires it',
    ],
  ])('refuses %s, writing nothing', async (_case, declaration, reason) => {
    await writePack(declaration);
    await expect(packCommand('bindings', ['fixture'], options())).rejects.toThrow(reason);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses run-ended bindings on the file store, writing nothing', async () => {
    await writePack(RUN_ENDED_DECLARATION);
    await mkdir(join(root, 'home'), { recursive: true });
    await writeFile(join(root, 'home', 'config.yaml'), 'store: files\n');
    const databaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = '';
    try {
      await expect(packCommand('bindings', ['fixture'], options())).rejects.toBeInstanceOf(
        FileStoreUnsupportedError
      );
    } finally {
      if (databaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = databaseUrl;
    }
    expect(existsSync(out)).toBe(false);
  });
});
