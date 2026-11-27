/**
 * `archon pack bindings` against a minimal fixture pack, discovered from a real project
 * folder: what it writes is read back with the schemas of the loaders that consume it.
 */
import { closeDatabase } from '@archon/core/db/connection';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { githubWebhookSourceConfigSchema } from '@archon/adapters/forge/github/source-config';
import { defaultPlatformPolicies } from '@archon/adapters/platform-policies';
import { setPlatformPolicies } from '@archon/core/platforms/registry';
import { readAsksSettledBindings, readRunEndedBindings } from '@archon/core/workflows/run-ended';
import { FileStoreUnsupportedError } from '@archon/workflows/file-store';
import { removeTempTree } from '@archon/paths/test-utils';
import { packCommand, type PackBindingsOptions } from './pack';
import { packCopyLines } from './pack-copies';
import { loadWorkflows } from './workflow-list';
import { packTreePath, receiptPath } from '@archon/plugin-manifest/store';
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
    item: { field: number, prefix: issue- }
  opened:
    workflow: fixture-sweep
    resource: opened
    overlap: queue
    event:
      kind: issue.lifecycle
      actions: [opened]
    item: { field: subject.number, prefix: issue- }
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

// `fixture-ask` leaves asks; `build-again` starts `fixture-build` in its checkout once they are answered.
const ASKS_SETTLED_DECLARATION = `bindings:
  build-again:
    workflow: fixture-build
    resource: build
    overlap: queue
    asks_settled: { workflow: fixture-ask, settled: answered, checkout: asking-run }
    inputs:
      plan: { answers: true }
      issue: { input: issue }
`;

const ASK_WORKFLOW = `name: fixture-ask
description: d
inputs:
  issue: { required: true }
returns: { node: decide, asks: asks }
nodes:
  - id: decide
    bash: echo '{"asks":[]}'
    output_format:
      type: object
      properties:
        summary: { type: string }
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
  await writeWorkflow(pack, 'fixture-ask', ASK_WORKFLOW);
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
  // A check reads the scratch home's codebase records; close the database before it goes.
  await closeDatabase();
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
    expect(config.item).toEqual({ field: 'number', prefix: 'issue-' });
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
    expect(config.bindings[0]?.item).toEqual({ field: 'subject.number', prefix: 'issue-' });
  });

  it('writes an event binding that wakes a wait, with the met wait as an input', async () => {
    const WAKE = `bindings:
  checks-done:
    workflow: fixture-build
    resource: build
    overlap: queue
    event:
      kind: check.changed
      actions: [changed]
    wake: { workflow: fixture-plan, wait: checks, about: check.revision }
    inputs:
      plan: { wait: true }
      issue: { event: check.revision }
`;
    await writePack(WAKE);
    await packCommand('bindings', ['fixture'], options({ repo: 'github.com/acme/widgets' }));
    const [binding] = githubWebhookSourceConfigSchema.parse({
      version: 1,
      webhookSecretEnv: 'WEBHOOK_SECRET',
      host: 'github.com',
      bindings: [await readJson(await fileFor('checks-done'))],
    }).bindings;
    expect(binding?.wake).toEqual({
      workflow: 'fixture-plan',
      wait: 'checks',
      about: { field: 'check.revision' },
      input: 'plan',
    });
    expect(binding?.inputMapping).toEqual({
      issue: { source: 'field', field: 'check.revision' },
    });

    // The met wait exists only for a binding that wakes one.
    await writePack(WAKE.replace(/    wake: .*\n/, ''));
    await expect(packCommand('bindings', ['fixture'], options())).rejects.toThrow(
      "input 'plan' reads the met wait, but only an event binding with wake has one"
    );
  });

  it("writes a wake binding that carries the waiting run's inputs, the item's answers and its checkout", async () => {
    // `fixture-plan` waits; `fixture-build` is started, and declares `mode`, which the
    // waiting `fixture-plan` does not.
    const WAKE = `bindings:
  checks-done:
    workflow: fixture-build
    resource: build
    overlap: queue
    event:
      kind: check.changed
      actions: [changed]
    wake: { workflow: fixture-plan, wait: checks, about: check.revision, checkout: waiting-run }
    inputs:
      issue: { input: issue }
      plan: { item: answers }
`;
    const github = () => options({ repo: 'github.com/acme/widgets' });
    await writePack(WAKE);
    await packCommand('bindings', ['fixture'], github());
    const [binding] = githubWebhookSourceConfigSchema.parse({
      version: 1,
      webhookSecretEnv: 'WEBHOOK_SECRET',
      host: 'github.com',
      bindings: [await readJson(await fileFor('checks-done'))],
    }).bindings;
    expect(binding?.wake).toEqual({
      workflow: 'fixture-plan',
      wait: 'checks',
      about: { field: 'check.revision' },
      inputs: { issue: { input: 'issue' }, plan: { item: 'answers' } },
      checkout: 'waiting-run',
    });
    expect(binding?.inputMapping).toEqual({});

    // The read is of the waiting run, so the started workflow's declaration does not count.
    await writePack(WAKE.replace('issue: { input: issue }', 'mode: { input: mode }'));
    await expect(
      packCommand('bindings', ['fixture'], { ...github(), force: true })
    ).rejects.toThrow(
      "Binding 'checks-done': input 'mode' reads 'mode', which 'fixture-plan' does not declare"
    );
    // A waiting run's result is not kept for the start a wake makes.
    await writePack(WAKE.replace('{ input: issue }', '{ result: /plan }'));
    await expect(
      packCommand('bindings', ['fixture'], { ...github(), force: true })
    ).rejects.toThrow(
      "input 'issue' reads a result, but a wake start reads the waiting run's inputs, not its result"
    );
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

  it('says when --force changes or drops the run config its starts will use', async () => {
    await writePack(DECLARATION);
    const runConfig = join(root, 'lane.yaml');
    await writeFile(runConfig, 'assistants: {}\n');
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await packCommand('bindings', ['fixture'], options({ only: 'sweep', config: runConfig }));
      await packCommand(
        'bindings',
        ['fixture'],
        options({ only: 'sweep', config: runConfig, force: true })
      );
      // Rewriting the same config says nothing.
      expect(warnSpy.mock.calls).toEqual([]);

      // Regenerating without it would otherwise put the lane back on the install's config.
      await packCommand('bindings', ['fixture'], options({ only: 'sweep', force: true }));
      expect(warnSpy.mock.calls.flat().join('\n')).toContain('removed its run config');
      expect(warnSpy.mock.calls.flat().join('\n')).toContain(runConfig);
      warnSpy.mockClear();

      await packCommand(
        'bindings',
        ['fixture'],
        options({ only: 'sweep', config: runConfig, force: true })
      );
      expect(warnSpy.mock.calls.flat().join('\n')).toContain('added run config');
    } finally {
      warnSpy.mockRestore();
    }
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
    expect(bindings.map(entry => entry.runEnded.outcome).sort()).toEqual(['blocked', 'planned']);
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

  it('writes a linked binding into on.runEnded.linked, with the items it names and their entries', async () => {
    const declaration = RUN_ENDED_DECLARATION.replace(
      '[planned, blocked] }',
      'planned, linked: { kind: part_of, holder: from, items: /start } }'
    ).replace('{ input: issue }', '{ entry: /brief }');
    await writePack(declaration);
    await packCommand('bindings', ['fixture'], options());

    const [entry, ...rest] = await readRunEndedBindings(out);
    expect(rest).toEqual([]);
    expect(entry?.runEnded).toEqual({
      workflowName: 'fixture-plan',
      outcome: 'planned',
      linked: { kind: 'part_of', holder: 'from', items: '/start' },
      inputs: { plan: { result: '/plan' }, issue: { entry: '/brief' } },
    });
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

describe('archon pack bindings: asks-settled', () => {
  it("writes one trigger file that takes the asking run's checkout and its answers, and activates none", async () => {
    await writePack(ASKS_SETTLED_DECLARATION);
    await packCommand('bindings', ['fixture'], options());

    expect(existsSync(join(root, 'home', 'triggers'))).toBe(false);
    const [binding, ...others] = await readAsksSettledBindings(out);
    expect(others).toEqual([]);
    expect(binding?.asksSettled).toEqual({
      workflowName: 'fixture-ask',
      settled: 'answered',
      checkout: 'asking-run',
      inputs: { plan: { answers: true }, issue: { input: 'issue' } },
    });
    expect(binding?.binding.launch.isolation).toEqual({ kind: 'default' });
    expect(logSpy.mock.calls.flat().join('\n')).toContain(`archon trigger add '${binding?.file}'`);
  });

  it('writes one trigger file per option a binding lists', async () => {
    await writePack(
      ASKS_SETTLED_DECLARATION.replace(
        'settled: answered,',
        'settled: answered, option: [keep, drop],'
      )
    );
    await packCommand('bindings', ['fixture'], options());

    const bindings = await readAsksSettledBindings(out);
    expect(bindings.map(entry => entry.asksSettled.option).sort()).toEqual(['drop', 'keep']);
    expect(logSpy.mock.calls.flat().join('\n')).toContain("# option 'keep'");
  });

  it.each([
    [
      'two bindings that both start when one option is chosen',
      `${ASKS_SETTLED_DECLARATION.replace('settled: answered,', 'settled: answered, option: keep,')}  build-on-answers:\n    workflow: fixture-build\n    resource: build\n    overlap: queue\n    asks_settled: { workflow: fixture-ask, settled: answered }\n    inputs:\n      plan: { answers: true }\n      issue: { input: issue }\n`,
      "starts when option 'keep' is chosen",
    ],
    [
      'an asking workflow that declares no returns.asks',
      ASKS_SETTLED_DECLARATION.replace('workflow: fixture-ask', 'workflow: fixture-plan'),
      "'fixture-plan' declares no returns.asks",
    ],
    [
      'an input the started workflow does not declare',
      ASKS_SETTLED_DECLARATION.replace('plan: { answers: true }', 'decisions: { answers: true }'),
      "does not declare input 'decisions'",
    ],
  ])('refuses %s, writing nothing', async (_case, declaration, reason) => {
    await writePack(
      `${declaration}  sweep:\n    workflow: fixture-sweep\n    resource: sweep\n    overlap: skip\n`
    );
    await expect(packCommand('bindings', ['fixture'], options())).rejects.toThrow(reason);
    expect(existsSync(out)).toBe(false);
  });
});

describe('archon pack bindings: start limits', () => {
  // `build` starts three times per item, again after `fixture-plan` completes on it; an
  // answer that settles `fixture-ask`'s asks allows it one more.
  const LIMITED = `${RUN_ENDED_DECLARATION.replace(
    '    overlap: queue\n',
    '    overlap: queue\n    limit: { starts: 3, reset_on: fixture-plan }\n'
  )}${ASKS_SETTLED_DECLARATION.replace('bindings:\n', '').replace(
    '    overlap: queue\n',
    '    overlap: queue\n    grants: build\n'
  )}`;

  it('writes one limit that every outcome file of a binding counts under, and the grant that names it', async () => {
    await writePack(LIMITED);
    await packCommand('bindings', ['fixture'], options());

    const [planned, blocked, ...more] = await readRunEndedBindings(out);
    expect(more).toEqual([]);
    expect(planned?.binding.limit).toEqual({
      // Named without an outcome, so both files count under one name.
      name: expect.stringMatching(/^fixture-acme-widgets-build-[0-9a-f]{12}$/),
      starts: 3,
      resetOn: 'fixture-plan',
    });
    expect(blocked?.binding.limit).toEqual(planned?.binding.limit);
    const [grant] = await readAsksSettledBindings(out);
    expect(grant?.binding.grants).toBe(planned?.binding.limit?.name);
    expect(grant?.binding.limit).toBeUndefined();
  });

  it.each([
    ['an unknown binding', 'grants: build', 'grants: missing', "grants unknown binding 'missing'"],
    [
      'a binding with no limit',
      '    limit: { starts: 3, reset_on: fixture-plan }\n',
      '',
      "grants binding 'build', which declares no limit",
    ],
  ])('refuses a grant that names %s', async (_case, from, to, reason) => {
    await writePack(LIMITED.replace(from, to));
    await expect(packCommand('bindings', ['fixture'], options())).rejects.toThrow(reason);
  });
});

describe('archon pack: a pack folder as the workflow source', () => {
  /** The fixture pack as its author keeps it: its own folder, manifest at the root. */
  async function writePackFolder(): Promise<string> {
    const dir = join(root, 'fixture-pack');
    await mkdir(join(dir, '.archon'), { recursive: true });
    await writeFile(
      join(dir, '.archon', 'config.yaml'),
      'defaults:\n  loadDefaultWorkflows: false\n  loadDefaultCommands: false\n'
    );
    await writeFile(
      join(dir, 'archon-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'workflow-pack',
        name: 'fixture',
        description: 'd',
        entrypoints: { 'fixture-sweep': 'fixture-sweep/fixture-sweep.yaml' },
      })
    );
    await mkdir(join(dir, '.pack'), { recursive: true });
    await writeFile(join(dir, '.pack', 'pack.yaml'), DECLARATION);
    await writeWorkflow(
      dir,
      'fixture-sweep',
      'name: fixture-sweep\ndescription: d\nnodes:\n  - id: a\n    bash: echo hi\n'
    );
    return dir;
  }

  it('graph and bindings read the folder and say which copy they loaded', async () => {
    const source = await writePackFolder();
    await mkdir(cwd, { recursive: true });

    await packCommand('graph', ['fixture'], options({ workflowSource: source }));
    const printed = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(printed).toContain(`Pack 'fixture' loaded from ${source} (project`);
    expect(printed).toContain('fixture-sweep');

    let json = '';
    const write = spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      ...rest: unknown[]
    ) => {
      json += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      (rest.find(arg => typeof arg === 'function') as (() => void) | undefined)?.();
      return true;
    }) as typeof process.stdout.write);
    try {
      await packCommand(
        'bindings',
        ['fixture'],
        options({ workflowSource: source, only: 'sweep,after', json: true })
      );
    } finally {
      write.mockRestore();
    }
    // The test process's logger shares stdout; the command's payload is the last document.
    expect(JSON.parse(json.slice(json.lastIndexOf('\n{\n') + 1))).toMatchObject({
      loaded: [{ source: 'project', key: 'fixture', dir: source }],
      otherCopies: [],
    });
  });

  it('with an installed copy too, the hint to use it drops --workflow-source, and following it works', async () => {
    const source = await writePackFolder();
    // The same pack installed as acme/fixture, the way `archon plugin add` leaves it.
    const pluginsDir = join(root, 'home', 'plugins');
    const id = 'acme/fixture';
    const commit = 'a'.repeat(40);
    await cp(source, packTreePath(pluginsDir, id, commit), {
      recursive: true,
      filter: path => !path.includes(`${source}/.archon`),
    });
    const manifest = JSON.parse(await readFile(join(source, 'archon-plugin.json'), 'utf8'));
    const receipt = receiptPath(pluginsDir, id);
    await mkdir(dirname(receipt), { recursive: true });
    await writeFile(
      receipt,
      JSON.stringify({
        schemaVersion: 1,
        id,
        manifest,
        commit,
        installedAt: new Date(0).toISOString(),
      })
    );
    await mkdir(join(cwd, '.archon'), { recursive: true });
    await writeFile(
      join(cwd, '.archon', 'config.yaml'),
      'defaults:\n  loadDefaultWorkflows: false\n  loadDefaultCommands: false\n'
    );

    await packCommand('graph', ['fixture'], options({ workflowSource: source }));
    const printed = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(printed).toContain("Drop --workflow-source and name 'acme.fixture' to use it.");

    // Following the hint: the installed copy, discovered from the checkout.
    await packCommand('bindings', ['acme.fixture'], options({ only: 'sweep' }));
    const written = JSON.stringify(await readJson(await fileFor('sweep')));
    expect(written).toContain('acme/fixture:fixture-sweep');
    expect(written).not.toContain(source);
  });
});

describe('run-start pack copy lines', () => {
  /** One installed copy of review-kit, the way `archon plugin add` leaves it. */
  async function install(owner: string): Promise<void> {
    const pluginsDir = join(root, 'home', 'plugins');
    const id = `${owner}/review-kit`;
    const commit = 'a'.repeat(40);
    const manifest = {
      schemaVersion: 1,
      kind: 'workflow-pack',
      name: 'review-kit',
      description: 'd',
      entrypoints: { review: 'review/review.yaml' },
    };
    const tree = packTreePath(pluginsDir, id, commit);
    await mkdir(join(tree, 'review'), { recursive: true });
    await writeFile(join(tree, 'archon-plugin.json'), JSON.stringify(manifest));
    await writeFile(
      join(tree, 'review', 'review.yaml'),
      'name: review\ndescription: d\nnodes:\n  - id: a\n    bash: echo hi\n'
    );
    const receipt = receiptPath(pluginsDir, id);
    await mkdir(dirname(receipt), { recursive: true });
    await writeFile(
      receipt,
      JSON.stringify({
        schemaVersion: 1,
        id,
        manifest,
        commit,
        installedAt: new Date(0).toISOString(),
      })
    );
  }

  it("names another owner's installed copy by its own qualified workflow name", async () => {
    await install('acme');
    await install('beta');
    await mkdir(cwd, { recursive: true });
    const { workflows } = await loadWorkflows(cwd);
    const selected = workflows.find(entry => entry.workflow.name === 'acme/review-kit:review');
    if (selected === undefined) throw new Error('acme/review-kit:review was not discovered');

    const lines = await packCopyLines(selected.workflow, workflows, cwd, false);

    expect(lines.join('\n')).toContain("To run it, name 'beta/review-kit:review'.");
  });
});
