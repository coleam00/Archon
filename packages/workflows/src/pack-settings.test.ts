// @archon-test-isolated
/**
 * Pack settings at load: a pack's declaration, the project's settings file, and the pack
 * a discovered workflow carries. Every failure names the file and the key.
 */
import { providerRegistry } from '@archon/providers';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, symlink, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readProjectPackSettings,
  packSettingValue,
  validateProjectPackSettings,
  parsePackDeclaration,
  PackSettingsError,
  FileSettingError,
  resolveRunStartInputs,
} from './pack-settings';
import type { PackSettingOrigin, PackSettingSpec } from './schemas/pack-settings';
import type { ResolvedWorkflow } from './schemas';
import { discoverWorkflows } from './workflow-discovery';
import { resolveTopLevelInputs } from './utils/workflow-requirements';
import { WorkflowInputContractError } from './workflow-inputs';

let cwd: string;
const originalArchonHome = process.env.ARCHON_HOME;

beforeEach(async () => {
  cwd = join(tmpdir(), `packdecl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(cwd, '.archon', 'workflows'), { recursive: true });
  process.env.ARCHON_HOME = join(cwd, 'home');
});

afterEach(async () => {
  await removeTempTree(cwd);
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
});

const SPECS: Record<string, PackSettingSpec> = {
  forge: { type: 'enum', values: ['gh', 'glab'] },
  strict: { type: 'bool' },
  reviewers: { type: 'list' },
  label: { type: 'string' },
};

describe('packSettingValue', () => {
  it.each([
    ['forge', 'gh', 'gh'],
    ['strict', true, 'true'],
    ['strict', 'false', 'false'],
    ['reviewers', 'ann, bo', 'ann, bo'],
    ['reviewers', '', ''],
    ['label', 'anything at all', 'anything at all'],
  ])('accepts %s = %p as %p', (name, raw, expected) => {
    expect(packSettingValue(SPECS[name], raw)).toEqual({ value: expected });
  });

  it.each([
    ['forge', 'bitbucket', 'must be one of gh, glab'],
    ['strict', 'yes', 'must be true or false'],
    ['reviewers', 'ann,,bo', 'no empty items'],
    ['label', 3, 'must be a string'],
    ['label', true, 'must be a string'],
  ])('refuses %s = %p', (name, raw, reason) => {
    const result = packSettingValue(SPECS[name], raw);
    expect('error' in result && result.error).toContain(reason);
  });
});

describe('parsePackDeclaration', () => {
  it('reads typed settings and normalizes a YAML boolean default to text', () => {
    expect(
      parsePackDeclaration(
        'inputs:\n  strict:\n    type: bool\n    default: true\n  forge:\n    type: enum\n    values: [gh, glab]\n    required: true\n  note:\n    description: free text\n',
        'p/.pack/pack.yaml'
      )
    ).toEqual({
      settings: {
        strict: { type: 'bool', default: 'true' },
        forge: { type: 'enum', values: ['gh', 'glab'], required: true },
        note: { type: 'string', description: 'free text' },
      },
    });
  });

  it('reads sections and file settings in the order the pack lists them', () => {
    const declared = parsePackDeclaration(
      'inputs:\n  review_policy:\n    section: Policies\n    file: true\n    default: docs/review.md\n  strict:\n    type: bool\n    section: Gates\n  plan_policy:\n    section: Policies\n    file: false\n  loose: {}\n',
      'p/.pack/pack.yaml'
    );
    expect(declared).toEqual({
      settings: {
        review_policy: {
          type: 'string',
          section: 'Policies',
          file: true,
          default: 'docs/review.md',
        },
        strict: { type: 'bool', section: 'Gates' },
        plan_policy: { type: 'string', section: 'Policies' },
        loose: { type: 'string' },
      },
    });
    expect(Object.keys(declared.settings ?? {})).toEqual([
      'review_policy',
      'strict',
      'plan_policy',
      'loose',
    ]);
    expect(Object.hasOwn(declared.settings?.plan_policy ?? {}, 'file')).toBe(false);
  });

  it('ignores an unknown key on an input and reports it as a warning', () => {
    const declared = parsePackDeclaration(
      'inputs:\n  tone:\n    secton: Style\n    default: calm\n',
      'p/.pack/pack.yaml'
    );
    expect(declared.settings).toEqual({ tone: { type: 'string', default: 'calm' } });
    expect(declared.warnings).toHaveLength(1);
    expect(declared.warnings?.[0]).toContain('secton');
  });

  it('refuses file: true on a non-string setting, naming the file and setting', () => {
    const parse = (): unknown =>
      parsePackDeclaration(
        'inputs:\n  marked_bool:\n    type: bool\n    file: true\n',
        'p/.pack/pack.yaml'
      );
    expect(parse).toThrow(PackSettingsError);
    expect(parse).toThrow('marked_bool');
    expect(parse).toThrow('p/.pack/pack.yaml');
  });

  it.each([
    ['settings:\n  a: {}\n', "unknown key 'settings'"],
    ['inputs:\n  "bad name": {}\n', "input 'bad name' is not a valid name"],
    ['inputs:\n  forge:\n    type: enum\n', "input 'forge' is invalid"],
    ['inputs:\n  forge:\n    type: string\n    values: [a]\n', "input 'forge' is invalid"],
    ['inputs:\n  strict:\n    type: bool\n    default: maybe\n', "input 'strict' default"],
    ['inputs:\n  x:\n    required: true\n    default: a\n', "input 'x' sets both"],
    ['inputs:\n  foo-bar: {}\n  foo_bar: {}\n', "both map to env var 'INPUTS_FOO_BAR'"],
    ['inputs:\n  __proto__:\n    default: a\n', "'__proto__' cannot be a setting name"],
  ])('refuses %p, naming the file and key', (yaml, reason) => {
    expect(() => parsePackDeclaration(yaml, 'p/.pack/pack.yaml')).toThrow(PackSettingsError);
    expect(() => parsePackDeclaration(yaml, 'p/.pack/pack.yaml')).toThrow(reason);
    expect(() => parsePackDeclaration(yaml, 'p/.pack/pack.yaml')).toThrow('p/.pack/pack.yaml');
  });
});

describe('parsePackDeclaration forge', () => {
  it('reads the capability tokens the pack calls', () => {
    expect(
      parsePackDeclaration(
        'forge:\n  operations: [pr.view, resolve:subject]\n',
        'p/.pack/pack.yaml'
      )
    ).toEqual({ forge: { operations: ['pr.view', 'resolve:subject'] } });
    expect(
      parsePackDeclaration(
        'forge:\n  operations: [pr.view]\n  repository: { host: repo_host, path: repo_path }\n',
        'p/.pack/pack.yaml'
      )
    ).toEqual({
      forge: { operations: ['pr.view'], repository: { host: 'repo_host', path: 'repo_path' } },
    });
  });

  it.each([
    ['forge:\n  operations: []\n', "'forge' is invalid at 'operations'"],
    ['forge:\n  operations: [pr.view, 3]\n', "'forge' is invalid at 'operations.1'"],
    ['forge:\n  operations: [pr.view]\n  host: github.com\n', "'forge' is invalid"],
    [
      'forge:\n  operations: [pr.view]\n  repository: { host: h, path: p, ref: r }\n',
      "'forge' is invalid",
    ],
    ['forge: [pr.view]\n', "'forge' must be a mapping"],
  ])('refuses %p, naming the file', (yaml, reason) => {
    expect(() => parsePackDeclaration(yaml, 'p/.pack/pack.yaml')).toThrow(reason);
    expect(() => parsePackDeclaration(yaml, 'p/.pack/pack.yaml')).toThrow('p/.pack/pack.yaml');
  });
});

describe('parsePackDeclaration bindings', () => {
  const timer = (extra = ''): string =>
    `  sweep:\n    workflow: sweep\n    resource: sweep\n    overlap: skip\n    schedule: { interval_seconds: 60 }\n${extra}`;

  it('reads a timer, an event and a fire-only binding, applying the defaults', () => {
    const declared = parsePackDeclaration(
      `bindings:\n${timer('    inputs:\n      self: { binding: sweep }\n      host: { repo: host }\n      mode: fast\n      next: { binding: follow-up }\n')}  follow-up:\n    workflow: sweep\n    resource: follow-up\n    overlap: queue\n    item: { field: number, prefix: issue- }\n  opened:\n    workflow: sweep\n    resource: opened\n    capacity: 2\n    overlap: queue\n    isolation: { kind: worktree }\n    event: { kind: issue.lifecycle, actions: [opened] }\n    item: { field: subject.number }\n    inputs:\n      number: { event: subject.number }\n`,
      'p/.pack/pack.yaml'
    );
    expect(declared).toEqual({
      bindings: {
        sweep: {
          workflow: 'sweep',
          resource: 'sweep',
          resource_scope: 'repo',
          overlap: 'skip',
          isolation: { kind: 'default' },
          schedule: { interval_seconds: 60 },
          inputs: {
            self: { binding: 'sweep' },
            host: { repo: 'host' },
            mode: 'fast',
            next: { binding: 'follow-up' },
          },
        },
        // Neither `schedule` nor `event`: only `trigger fire` starts it.
        'follow-up': {
          workflow: 'sweep',
          resource: 'follow-up',
          resource_scope: 'repo',
          overlap: 'queue',
          isolation: { kind: 'default' },
          inputs: {},
          item: { field: 'number', prefix: 'issue-' },
        },
        opened: {
          workflow: 'sweep',
          resource: 'opened',
          resource_scope: 'repo',
          capacity: 2,
          overlap: 'queue',
          isolation: { kind: 'worktree' },
          event: { kind: 'issue.lifecycle', actions: ['opened'] },
          inputs: { number: { event: 'subject.number' } },
          item: { field: 'subject.number' },
        },
      },
    });
  });

  it('reads a run-ended binding with its outcomes and the ended run inputs it maps', () => {
    const declared = parsePackDeclaration(
      `bindings:\n${timer()}  plan:\n    workflow: plan\n    resource: plan\n    overlap: queue\n    run_ended: { workflow: triage, outcome: [build, narrow] }\n    inputs:\n      issue: { input: issue }\n      verdict: { result: /verdict }\n      policy: docs/policy.md\n      next: { binding: sweep }\n      decided: { item: answers }\n`,
      'p/.pack/pack.yaml'
    );
    expect(declared.bindings?.plan).toEqual({
      workflow: 'plan',
      resource: 'plan',
      resource_scope: 'repo',
      overlap: 'queue',
      isolation: { kind: 'default' },
      run_ended: { workflow: 'triage', outcome: ['build', 'narrow'] },
      inputs: {
        issue: { input: 'issue' },
        verdict: { result: '/verdict' },
        policy: 'docs/policy.md',
        next: { binding: 'sweep' },
        decided: { item: 'answers' },
      },
    });
  });

  it("reads an asks-settled binding that takes the asking run's checkout and its answers", () => {
    const declared = parsePackDeclaration(
      `bindings:\n  build-again:\n    workflow: build\n    resource: build\n    overlap: queue\n    asks_settled: { workflow: build, settled: answered, checkout: asking-run }\n    inputs:\n      decisions: { answers: true }\n      issue: { input: issue }\n      decided: { item: answers }\n`,
      'p/.pack/pack.yaml'
    );
    expect(declared.bindings?.['build-again']).toEqual({
      workflow: 'build',
      resource: 'build',
      resource_scope: 'repo',
      overlap: 'queue',
      isolation: { kind: 'default' },
      asks_settled: { workflow: 'build', settled: 'answered', checkout: 'asking-run' },
      inputs: {
        decisions: { answers: true },
        issue: { input: 'issue' },
        decided: { item: 'answers' },
      },
    });
  });

  it.each([
    [timer('    inputs:\n      other: { binding: missing }\n'), "names unknown binding 'missing'"],
    [
      `${timer()}${'  plan:\n    workflow: plan\n    resource: plan\n    overlap: queue\n    run_ended: { workflow: triage, outcome: done }\n'}  ref:\n    workflow: w\n    resource: x\n    overlap: skip\n    inputs:\n      p: { binding: plan }\n`,
      "names run-ended binding 'plan'",
    ],
    [
      timer('    inputs:\n      v: { result: /verdict }\n'),
      'only a run-ended or asks-settled binding has a run to read',
    ],
    [
      '  plan:\n    workflow: plan\n    resource: plan\n    overlap: queue\n    run_ended: { workflow: triage, outcome: done }\n    inputs:\n      d: { answers: true }\n',
      'only an asks-settled binding has them',
    ],
    [
      '  build:\n    workflow: build\n    resource: build\n    overlap: queue\n    isolation: { kind: worktree }\n    asks_settled: { workflow: build, settled: answered, checkout: asking-run }\n',
      "binding 'build' is invalid at 'isolation'",
    ],
    [
      '  plan:\n    workflow: plan\n    resource: plan\n    overlap: queue\n    run_ended: { workflow: triage, outcome: [done, done] }\n',
      'outcomes must be distinct',
    ],
    [
      '  plan:\n    workflow: plan\n    resource: plan\n    overlap: queue\n    run_ended: { workflow: triage, outcome: [] }\n',
      "binding 'plan' is invalid at 'run_ended.outcome'",
    ],
    [
      '  plan:\n    workflow: plan\n    resource: plan\n    overlap: queue\n    run_ended: { workflow: triage, outcome: done, linked: { kind: owns, holder: to } }\n',
      "binding 'plan' is invalid at 'run_ended.linked.kind'",
    ],
    [
      '  plan:\n    workflow: plan\n    resource: plan\n    overlap: queue\n    run_ended: { workflow: triage, outcome: done, checkout: ended-run, linked: { kind: part_of, holder: to } }\n',
      "binding 'plan' is invalid at 'run_ended.checkout': A linked start takes no checkout",
    ],
    [
      '  plan:\n    workflow: plan\n    resource: plan\n    overlap: queue\n    run_ended: { workflow: triage, outcome: done, linked: { kind: part_of, holder: to } }\n    inputs:\n      d: { item: answers }\n',
      "binding 'plan' input 'd' reads the item's answers, but a linked start is on a holder item",
    ],
    [
      '  plan:\n    workflow: plan\n    resource: plan\n    overlap: queue\n    run_ended: { workflow: triage, outcome: done, linked: { kind: part_of, holder: to } }\n    inputs:\n      b: { entry: /brief }\n',
      "binding 'plan' input 'b' reads a linked entry, but only a run-ended binding with linked.items has one per started item",
    ],
    [timer('    inputs:\n      d: { item: answers }\n'), "reads the item's answers, but only"],
    [
      '  build:\n    workflow: build\n    resource: build\n    overlap: queue\n    asks_settled: { workflow: build, settled: answered }\n    inputs:\n      m: { item: key }\n',
      "binding 'build' input 'm' reads the ended run's item key, but only a run-ended binding has one",
    ],
    [
      '  plan:\n    workflow: plan\n    resource: plan\n    overlap: queue\n    run_ended: { outcome: done }\n',
      "binding 'plan' is invalid at 'run_ended.workflow'",
    ],
    [
      timer('    inputs:\n      n: { event: subject.number }\n'),
      'only an event binding has an event',
    ],
    [timer('    event: { kind: issue.lifecycle }\n'), "must set at most one of 'schedule'"],
    [timer('    item: { field: number }\n'), 'Unrecognized key: "item"'],
    // A schedule key without its expression is a broken timer, never a fire-only binding.
    [
      '  sweep:\n    workflow: sweep\n    resource: sweep\n    overlap: skip\n    schedule:\n',
      "binding 'sweep' is invalid at 'schedule'",
    ],
    [
      '  sweep:\n    workflow: sweep\n    resource: sweep\n    overlap: skip\n    schedule: {}\n',
      "binding 'sweep' is invalid at 'schedule.interval_seconds'",
    ],
    [timer('    overlap_policy: skip\n'), "binding 'sweep' is invalid"],
    ['  Bad_Id:\n    workflow: w\n', "binding 'Bad_Id' is not a valid id"],
    [
      '  ev:\n    workflow: w\n    resource: r\n    overlap: skip\n    event: { kind: k, repository: { host: h, path: o/r } }\n',
      "must not name 'repository'",
    ],
    [
      `${timer()}  ev:\n    workflow: w\n    resource: r\n    overlap: skip\n    event: { kind: k }\n  ref:\n    workflow: w\n    resource: x\n    overlap: skip\n    schedule: { interval_seconds: 5 }\n    inputs:\n      e: { binding: ev }\n`,
      "names event binding 'ev'",
    ],
  ])('refuses %p, naming the file and binding', (bindings, reason) => {
    const parse = (): unknown =>
      parsePackDeclaration(`bindings:\n${bindings}`, 'p/.pack/pack.yaml');
    expect(parse).toThrow(PackSettingsError);
    expect(parse).toThrow(reason);
    expect(parse).toThrow('p/.pack/pack.yaml');
  });
});

describe('readProjectPackSettings', () => {
  const pack = { key: 'alpha', source: 'project' as const, settings: SPECS };
  const projectFile = (): string => join(cwd, '.archon', 'packs', 'alpha.yaml');

  async function writeProject(yaml: string): Promise<void> {
    await mkdir(join(cwd, '.archon', 'packs'), { recursive: true });
    await writeFile(projectFile(), yaml);
  }

  it('reads nothing from a missing file', async () => {
    expect(await readProjectPackSettings(cwd, pack)).toEqual({});
  });

  it("returns only the file's values, not declaration defaults", async () => {
    await writeProject('settings:\n  forge: glab\n  strict: false\n');
    const declared = {
      key: 'alpha',
      source: 'project',
      settings: { ...SPECS, label: { type: 'string', default: 'd' } },
    } as const;
    expect(await readProjectPackSettings(cwd, declared)).toEqual({
      forge: 'glab',
      strict: 'false',
    });
  });

  it.each([
    ['settings:\n  colour: red\n', "unknown setting 'colour'"],
    ['config:\n  forge: gh\n', "unknown key 'config'"],
    ...Object.keys(SPECS).flatMap(name => [
      [`settings:\n  ${name}: &a [*a]\n`, `setting '${name}' must be a string`],
      [`settings:\n  ${name}: &a {self: *a}\n`, `setting '${name}' must be a string`],
    ]),
  ])('refuses %p, naming the file and key', async (yaml, reason) => {
    await writeProject(yaml);
    const loading = readProjectPackSettings(cwd, pack);
    await expect(loading).rejects.toThrow(PackSettingsError);
    await expect(loading).rejects.toThrow(reason);
    await expect(readProjectPackSettings(cwd, pack)).rejects.toThrow(projectFile());
  });

  it('refuses any setting for a pack that declares none', async () => {
    await writeProject('settings:\n  forge: gh\n');
    await expect(readProjectPackSettings(cwd, { key: 'alpha', source: 'project' })).rejects.toThrow(
      "pack 'alpha' declares no settings"
    );
  });
});

describe('validateProjectPackSettings file settings', () => {
  type PackWorkflow = Pick<ResolvedWorkflow, 'pack' | 'inputs'>;
  const projectFile = (): string => join(cwd, '.archon', 'packs', 'alpha.yaml');
  const packWith = (settings: Record<string, PackSettingSpec>): PackWorkflow => ({
    pack: { key: 'alpha', source: 'project', workflow: 'stage', settings },
  });
  const policy = packWith({ policy: { type: 'string', file: true } });

  async function writeProject(yaml: string): Promise<void> {
    await mkdir(join(cwd, '.archon', 'packs'), { recursive: true });
    await writeFile(projectFile(), yaml);
  }

  /** The one error validation reports, checked to name the setting and the file. */
  async function onlyError(pack: PackWorkflow, setting: string, file: string): Promise<void> {
    const errors = await validateProjectPackSettings(cwd, pack);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(setting);
    expect(errors[0]).toContain(file);
  }

  it('reports a file setting whose project value names a missing file', async () => {
    await writeProject('settings:\n  policy: docs/review.md\n');
    await onlyError(policy, 'policy', 'docs/review.md');
  });

  it('reports a missing default when the project sets nothing', async () => {
    const missing = join(cwd, 'docs', 'missing.md');
    await onlyError(
      packWith({ policy: { type: 'string', file: true, default: missing } }),
      'policy',
      missing
    );
  });

  it('reports a path that is a directory, or a file written with a trailing slash', async () => {
    await mkdir(join(cwd, 'docs'), { recursive: true });
    await writeFile(join(cwd, 'docs', 'review.md'), 'be kind\n');
    await writeProject('settings:\n  policy: docs\n');
    await onlyError(policy, 'policy', 'docs');
    await writeProject('settings:\n  policy: docs/review.md/\n');
    await onlyError(policy, 'policy', 'docs/review.md/');
    // Without the as-written check this value names a file everywhere: Windows `stat` drops the
    // `\` and finds review.md; on POSIX `\` is a filename character, so give it a file to find.
    if (process.platform !== 'win32') await writeFile(join(cwd, 'docs', 'review.md\\'), 'x\n');
    await writeProject('settings:\n  policy: docs/review.md\\\n');
    await onlyError(policy, 'policy', 'docs/review.md\\');
  });

  // POSIX only: there `..` applies after the link is followed, which is what tells a
  // checked-as-written path from a normalized one. Windows folds `..` before it reaches the
  // link, so on Windows both spellings name docs/policy.md and the case shows nothing.
  it.skipIf(process.platform === 'win32')(
    'checks a path through a directory symlink and .. the way the filesystem opens it',
    async () => {
      // docs/current -> versions/v2, so docs/current/../policy.md is versions/policy.md; a
      // normalized path would be docs/policy.md, which does not exist.
      await mkdir(join(cwd, 'versions', 'v2'), { recursive: true });
      await writeFile(join(cwd, 'versions', 'policy.md'), 'be kind\n');
      await mkdir(join(cwd, 'docs'), { recursive: true });
      await symlink(join(cwd, 'versions', 'v2'), join(cwd, 'docs', 'current'));
      await writeProject('settings:\n  policy: docs/current/../policy.md\n');
      expect(await validateProjectPackSettings(cwd, policy)).toEqual([]);
    }
  );

  it('reports a project value naming a missing file even when the default exists', async () => {
    await mkdir(join(cwd, 'docs'), { recursive: true });
    await writeFile(join(cwd, 'docs', 'default.md'), 'be kind\n');
    await writeProject('settings:\n  policy: docs/override.md\n');
    await onlyError(
      packWith({ policy: { type: 'string', file: true, default: 'docs/default.md' } }),
      'policy',
      'docs/override.md'
    );
  });

  it('accepts an existing relative or absolute file, and a value the project clears', async () => {
    await mkdir(join(cwd, 'docs'), { recursive: true });
    await writeFile(join(cwd, 'docs', 'review.md'), 'be kind\n');
    await writeProject('settings:\n  policy: docs/review.md\n');
    expect(await validateProjectPackSettings(cwd, policy)).toEqual([]);
    await writeProject(`settings:\n  policy: ${join(cwd, 'docs', 'review.md')}\n`);
    expect(await validateProjectPackSettings(cwd, policy)).toEqual([]);
    // The default names a missing file, so only the explicit empty value makes this pass.
    const withDefault = packWith({
      policy: { type: 'string', file: true, default: join(cwd, 'missing.md') },
    });
    await writeProject('settings:\n  policy: ""\n');
    expect(await validateProjectPackSettings(cwd, withDefault)).toEqual([]);
  });

  it('accepts an unset file setting with no default, even one named constructor', async () => {
    const spec: PackSettingSpec = { type: 'string', file: true };
    const pack = packWith(Object.fromEntries([['constructor', spec]]));
    expect(await validateProjectPackSettings(cwd, pack)).toEqual([]);
    await writeProject('settings: {}\n');
    expect(await validateProjectPackSettings(cwd, pack)).toEqual([]);
  });

  it('does not treat a setting as a file because its description says it is a path', async () => {
    const { settings } = parsePackDeclaration(
      'inputs:\n  note:\n    description: Path to the review policy\n',
      'alpha/.pack/pack.yaml'
    );
    const pack = packWith(settings ?? {});
    await writeProject('settings:\n  note: docs/absent.md\n');
    expect(await validateProjectPackSettings(cwd, pack)).toEqual([]);
  });

  it('refuses a start that reads a missing file, naming the setting, path and origin', async () => {
    await writeProject('settings:\n  policy: docs/review.md\n');
    const start = resolveRunStartInputs(cwd, policy, undefined);
    await expect(start).rejects.toBeInstanceOf(FileSettingError);
    const error = (await start.catch((e: unknown) => e)) as FileSettingError;
    expect({ setting: error.setting, path: error.path, origin: error.origin }).toEqual({
      setting: 'policy',
      path: join(cwd, 'docs', 'review.md'),
      origin: 'project',
    });
    // The same project state starts a workflow of the pack that does not read the setting.
    const unread: PackWorkflow = {
      pack: { ...(policy.pack as NonNullable<PackWorkflow['pack']>), fileSettingReads: [] },
    };
    expect(await resolveRunStartInputs(cwd, unread, undefined)).toEqual({
      inputs: { policy: 'docs/review.md' },
    });
    // Restoring the file lets the reading workflow start.
    await mkdir(join(cwd, 'docs'), { recursive: true });
    await writeFile(join(cwd, 'docs', 'review.md'), 'be kind\n');
    expect(await resolveRunStartInputs(cwd, policy, undefined)).toEqual({
      inputs: { policy: 'docs/review.md' },
    });
  });

  it('starts with an empty value, as validate accepts it', async () => {
    await writeProject('settings:\n  policy: ""\n');
    expect(await resolveRunStartInputs(cwd, policy, undefined)).toEqual({
      inputs: { policy: '' },
    });
  });

  it('agrees with start on what it reports, with the value resolved as start resolves it', async () => {
    await mkdir(join(cwd, 'docs'), { recursive: true });
    await writeFile(join(cwd, 'docs', 'present.md'), 'be kind\n');
    const missingDefault = packWith({
      policy: { type: 'string', file: true, default: 'docs/missing.md' },
    });
    const cases: { workflow: PackWorkflow; project?: string; origin?: PackSettingOrigin }[] = [
      { workflow: policy, project: 'settings:\n  policy: docs/missing.md\n', origin: 'project' },
      { workflow: missingDefault, origin: 'pack_default' },
      // A workflow input default beats the pack default, at start and in validate alike.
      {
        workflow: {
          ...missingDefault,
          inputs: { policy: { default: 'docs/present.md' } },
        },
      },
      {
        workflow: {
          ...policy,
          inputs: { policy: { default: 'docs/missing.md' } },
        },
        origin: 'workflow_default',
      },
    ];
    for (const { workflow, project, origin } of cases) {
      await writeProject(project ?? 'settings: {}\n');
      const reported = await validateProjectPackSettings(cwd, workflow);
      const refusal = await resolveRunStartInputs(cwd, workflow, undefined).then(
        () => undefined,
        (e: unknown) => e as FileSettingError
      );
      expect(refusal?.origin).toBe(origin);
      expect(reported).toEqual(refusal === undefined ? [] : [refusal.message]);
    }
  });
});

describe('readPackSettingEntries', () => {
  it('returns each discovered setting in declared order with its declaration and the project value', async () => {
    const pack = join(cwd, '.archon', 'workflows', 'alpha');
    await mkdir(join(pack, '.pack'), { recursive: true });
    await writeFile(
      join(pack, '.pack', 'pack.yaml'),
      'inputs:\n  review_policy:\n    description: the review policy\n    section: Policies\n    file: true\n    default: docs/review.md\n  strict:\n    type: bool\n    section: Gates\n  plan_policy:\n    section: Policies\n    file: true\n  loose:\n    default: x\n  tone:\n    default: calm\n'
    );
    await mkdir(join(pack, 'packed'), { recursive: true });
    await writeFile(
      join(pack, 'packed', 'packed.yaml'),
      'name: packed\ndescription: d\nnodes:\n  - id: a\n    bash: echo hi\n'
    );
    await mkdir(join(cwd, '.archon', 'packs'), { recursive: true });
    await writeFile(
      join(cwd, '.archon', 'packs', 'alpha.yaml'),
      'settings:\n  review_policy: docs/project-review.md\n  plan_policy: docs/plan.md\n  strict: true\n  loose: ""\n'
    );
    const { workflows, errors } = await discoverWorkflows(cwd, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    expect(errors).toEqual([]);
    const discovered = workflows[0]?.workflow.pack;
    if (discovered === undefined) throw new Error('packed was not discovered with its pack');
    // Read through the package entry point a host imports.
    const { readPackSettingEntries } = await import('@archon/workflows/pack-settings');
    expect(await readPackSettingEntries(cwd, discovered)).toEqual([
      {
        name: 'review_policy',
        spec: {
          type: 'string',
          description: 'the review policy',
          section: 'Policies',
          file: true,
          default: 'docs/review.md',
        },
        value: 'docs/project-review.md',
      },
      { name: 'strict', spec: { type: 'bool', section: 'Gates' }, value: 'true' },
      {
        name: 'plan_policy',
        spec: { type: 'string', section: 'Policies', file: true },
        value: 'docs/plan.md',
      },
      { name: 'loose', spec: { type: 'string', default: 'x' }, value: '' },
      { name: 'tone', spec: { type: 'string', default: 'calm' } },
    ]);
  });
});

describe('discovery carries the pack', () => {
  async function writePackWorkflow(pack: string, name: string, yaml: string): Promise<void> {
    const dir = join(cwd, '.archon', 'workflows', pack, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.yaml`), yaml);
  }
  async function writeDeclaration(pack: string, yaml: string): Promise<void> {
    await mkdir(join(cwd, '.archon', 'workflows', pack, '.pack'), { recursive: true });
    await writeFile(join(cwd, '.archon', 'workflows', pack, '.pack', 'pack.yaml'), yaml);
  }
  const discover = () =>
    discoverWorkflows(cwd, { providers: providerRegistry, loadDefaults: false });

  it('keys a scope pack by its folder and attaches its declaration; a flat workflow has none', async () => {
    await writeDeclaration(
      'alpha',
      'inputs:\n  tone:\n    default: calm\n    section: Style\n  policy:\n    file: true\n'
    );
    await writePackWorkflow(
      'alpha',
      'packed',
      'name: packed\ndescription: d\nnodes:\n  - id: a\n    bash: echo hi\n'
    );
    await writeFile(
      join(cwd, '.archon', 'workflows', 'flat.yaml'),
      'name: flat\ndescription: d\npack:\n  key: alpha\nnodes:\n  - id: a\n    bash: echo hi\n'
    );
    const { workflows, errors } = await discover();
    expect(errors).toEqual([]);
    const byName = new Map(workflows.map(w => [w.workflow.name, w.workflow]));
    expect(byName.get('packed')?.pack).toEqual({
      key: 'alpha',
      workflow: 'packed',
      source: 'project',
      settings: {
        tone: { type: 'string', default: 'calm', section: 'Style' },
        policy: { type: 'string', file: true },
      },
      fileSettingReads: [],
    });
    // A `pack:` key in YAML cannot claim a pack: only discovery sets it.
    expect(byName.get('flat')?.pack).toBeUndefined();
  });

  it("adds a declaration's ignored input keys to each pack workflow's parse warnings", async () => {
    await writeDeclaration('alpha', 'inputs:\n  tone:\n    secton: Style\n');
    await writePackWorkflow(
      'alpha',
      'packed',
      'name: packed\ndescription: d\nnodes:\n  - id: a\n    bash: echo hi\n'
    );
    const { workflows, errors } = await discover();
    expect(errors).toEqual([]);
    expect(workflows[0]?.parseWarnings?.some(warning => warning.includes('secton'))).toBe(true);
    expect(workflows[0]?.workflow.pack).not.toHaveProperty('warnings');
  });

  it('fails every workflow of a pack whose declaration is invalid, naming the file and key', async () => {
    await writeDeclaration('alpha', 'inputs:\n  strict:\n    type: bool\n    default: maybe\n');
    await writePackWorkflow(
      'alpha',
      'one',
      'name: one\ndescription: d\nnodes:\n  - id: a\n    bash: echo hi\n'
    );
    await writePackWorkflow(
      'alpha',
      'two',
      'name: two\ndescription: d\nnodes:\n  - id: a\n    bash: echo hi\n'
    );
    const { workflows, errors } = await discover();
    expect(workflows.map(w => w.workflow.name)).toEqual([]);
    expect(errors.map(e => e.filename).sort()).toEqual(['one.yaml', 'two.yaml']);
    for (const error of errors) {
      expect(error.error).toContain('alpha/.pack/pack.yaml');
      expect(error.error).toContain("input 'strict'");
    }
  });

  it('refuses a workflow input that collides with a pack setting on its env key', async () => {
    await writeDeclaration('alpha', 'inputs:\n  foo-bar: {}\n');
    await writePackWorkflow(
      'alpha',
      'clash',
      'name: clash\ndescription: d\ninputs:\n  foo_bar:\n    default: x\nnodes:\n  - id: a\n    bash: echo hi\n'
    );
    const { workflows, errors } = await discover();
    expect(workflows).toEqual([]);
    expect(errors[0]?.error).toContain("both map to env var 'INPUTS_FOO_BAR'");
  });

  it('lets a bash node of a pack workflow that declares inputs read a pack setting', async () => {
    await writeDeclaration('alpha', 'inputs:\n  tone: {}\n');
    await writePackWorkflow(
      'alpha',
      'reader',
      'name: reader\ndescription: d\ninputs:\n  own:\n    default: x\nnodes:\n  - id: a\n    bash: echo "$INPUTS_OWN $INPUTS_TONE"\n'
    );
    const { workflows, errors } = await discover();
    expect(errors).toEqual([]);
    expect(workflows.map(w => w.workflow.name)).toEqual(['reader']);
  });
});

describe('--input may set a pack setting for one run', () => {
  const workflow = {
    name: 'packed',
    inputs: { own: { default: 'x' } },
    pack: { key: 'alpha', source: 'project' as const, settings: SPECS },
  };

  it('accepts a pack setting of the right type', () => {
    expect(resolveTopLevelInputs(workflow, { forge: 'glab', own: 'y' })).toEqual({
      forge: 'glab',
      own: 'y',
    });
  });

  it('refuses a pack setting of the wrong type', () => {
    expect(() => resolveTopLevelInputs(workflow, { strict: 'yes' })).toThrow(
      "pack setting 'strict' must be true or false"
    );
  });

  it('still refuses a name neither the workflow nor its pack declares, listing both', () => {
    let thrown: unknown;
    try {
      resolveTopLevelInputs(workflow, { colour: 'red' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkflowInputContractError);
    expect((thrown as WorkflowInputContractError).undeclared).toEqual(['colour']);
    expect((thrown as Error).message).toContain('Pack settings: forge, label, reviewers, strict.');
  });
});
