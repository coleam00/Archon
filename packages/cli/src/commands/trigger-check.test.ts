// @archon-test-isolated
// @archon-test-windows
/**
 * `archon trigger check` reads the bindings this install can start, wherever a timer's
 * config lives, and reports a start that would be refused for its inputs, reading only.
 * `trigger schedule` finds the timer it installed by the same reading of `ARCHON_HOME`.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { triggerCheckFixtures } from '../test-support/trigger-check-fixture';
import { cliProgramArguments } from '../utils/cli-program-arguments';
import { installNativeSchedule, scheduleLabel } from '../triggers/native-schedule';
import {
  wakeLastPassPath,
  workflowWakeScheduleConfig,
  workflowWakeScheduleTarget,
  writeWakeLastPass,
} from './wake-schedule';

const { fixture, scheduleFixture } = triggerCheckFixtures();

test('reports an installed timer outside the triggers directory that passes an undeclared input', async () => {
  const { root, archonHome, config, installTimer, check, scheduled, timerPrefix } = await fixture();
  const path = join(root, 'bindings', 'merge-queue.json');
  await mkdir(join(root, 'bindings'));
  await writeFile(path, JSON.stringify(config({ a: 1, b: 1 })));
  await installTimer(path);
  scheduled.length = 0;
  // The home holds no config.yaml yet; check must not create one.
  const listing = async () => [
    await readdir(join(archonHome, 'triggers')),
    await readdir(archonHome),
    await readdir(root),
  ];
  const before = await listing();

  const { bindings, error } = await check();

  expect(bindings).toEqual([
    expect.objectContaining({
      file: path,
      workflowName: 'stage',
      timer: expect.stringContaining(timerPrefix),
      problems: [
        expect.stringContaining("Cannot run workflow 'stage': it does not declare input 'b'"),
      ],
    }),
  ]);
  expect(error).toBeInstanceOf(Error);
  // Reading only: no scheduler command, no file written.
  expect(scheduled).toEqual([]);
  expect(await listing()).toEqual(before);
});

test('reports a timer that omits a required input, naming it', async () => {
  const { root, config, installTimer, check } = await fixture();
  const path = join(root, 'timer.json');
  await writeFile(path, JSON.stringify(config({})));
  await installTimer(path);

  expect((await check()).bindings[0]?.problems).toEqual(["Workflow 'stage' requires input 'a'."]);
});

test('finds a timer when ARCHON_HOME reaches its home through a symlink', async () => {
  const { root, archonHome, config, installTimer, check } = await fixture();
  const path = join(root, 'timer.json');
  await writeFile(path, JSON.stringify(config({})));
  await installTimer(path);
  const alias = join(root, 'home-link');
  await symlink(archonHome, alias);
  process.env.ARCHON_HOME = alias;

  expect((await check()).bindings).toEqual([
    expect.objectContaining({ file: path, problems: ["Workflow 'stage' requires input 'a'."] }),
  ]);
});

test('reports a timer whose config file is gone, with how to remove it by hand', async () => {
  const { root, config, installTimer, check, removeByHand } = await fixture();
  const path = join(root, 'timer.json');
  await writeFile(path, JSON.stringify(config({ a: 1 })));
  await installTimer(path);
  await rm(path);

  const [broken] = (await check()).bindings;
  expect(broken).toMatchObject({ file: path, workflowName: null });
  expect(broken?.problems[0]).toContain('is missing; every tick fails');
  expect(broken?.problems[0]).toContain(removeByHand);
});

test('reports an invalid timer config inside the triggers directory with how to remove the timer', async () => {
  const { archonHome, config, installTimer, check, removeByHand } = await fixture();
  const path = join(archonHome, 'triggers', 'timer.json');
  await writeFile(path, JSON.stringify(config({ a: 1 })));
  await installTimer(path);
  await writeFile(path, JSON.stringify({ ...config({ a: 1 }), schedule: {} }));

  const [broken] = (await check()).bindings;
  expect(broken).toMatchObject({ file: path, timer: expect.any(String) });
  expect(broken?.problems[0]).toContain('is invalid: Invalid trigger configuration fields');
  expect(broken?.problems[0]).toContain(removeByHand);
});

test('a fire-only file may leave a required input to --inputs, but not pass an undeclared one', async () => {
  const { archonHome, config, check } = await fixture();
  const path = join(archonHome, 'triggers', 'fire-only.json');
  await writeFile(path, JSON.stringify(config({}, false)));
  const clean = await check();
  expect(clean.bindings).toEqual([expect.objectContaining({ file: path, problems: [] })]);
  expect(clean.error).toBeUndefined();

  await writeFile(path, JSON.stringify(config({ b: 1 }, false)));
  expect((await check()).bindings[0]?.problems).toEqual([
    expect.stringContaining("does not declare input 'b'"),
  ]);
});

test('reports the outcomes after which a stage a fire-only file starts would stop its item', async () => {
  const { root, archonHome, config, check } = await fixture();
  // The fixture's stage, with an outcome nothing binds and no asks, waits or final.
  await writeFile(
    join(root, 'project', '.archon', 'workflows', 'stage.yaml'),
    'name: stage\ndescription: A stage\ninputs:\n  a: { required: true }\nreturns: { node: one, outcome: stage }\nnodes:\n  - id: one\n    bash: echo \'{"stage":"replan"}\'\n    output_format:\n      type: object\n      properties:\n        stage: { type: string, enum: [replan] }\n      required: [stage]\n'
  );
  await writeFile(
    join(archonHome, 'triggers', 'fire-only.json'),
    JSON.stringify(config({}, false))
  );

  const checked = (await check()) as unknown as { stops: { workflow: string; outcome: string }[] };

  expect(checked.stops).toEqual([
    expect.objectContaining({ workflow: 'stage', outcome: 'replan' }),
  ]);
});

test('names the observing sources nothing watches with the fix, and the watcher once installed', async () => {
  const { root, archonHome, check, schedules } = await fixture();
  const plugin = join(root, 'source.mjs');
  await writeFile(
    plugin,
    `export default () => ({
  receive: async () => ({ kind: 'ignored' }),
  observedLabels: { reads: [{ bindingId: 'order', repo: { host: 'github.com', path: 'acme/app' }, label: 'factory' }] },
  observedOpenedIssues: {
    reads: [{ bindingId: 'triage', repo: { host: 'github.com', path: 'acme/app' } }],
    unserved: [{ bindingId: 'closing', reason: 'only an opened issue is observed' }],
  },
  unservedBindings: [{ bindingId: 'comments', reason: 'a comment.changed event is not observed' }],
  observe: async () => ({ events: [] }),
});
`
  );
  const sources = join(root, 'sources.json');
  await writeFile(
    sources,
    JSON.stringify({
      version: 1,
      sources: [
        { sourceInstanceId: 'github', module: plugin, config: {}, observe: { everySeconds: 60 } },
      ],
    })
  );
  delete process.env.ARCHON_WEBHOOK_SOURCES;
  expect((await check()).observing).toBeUndefined();
  process.env.ARCHON_WEBHOOK_SOURCES = sources;
  const observed = [
    {
      source: 'github',
      everySeconds: 60,
      labels: [
        { bindingId: 'order', repo: { host: 'github.com', path: 'acme/app' }, label: 'factory' },
      ],
      openedIssues: [{ bindingId: 'triage', repo: { host: 'github.com', path: 'acme/app' } }],
      unservedBindings: [
        { bindingId: 'closing', reason: 'only an opened issue is observed' },
        { bindingId: 'comments', reason: 'a comment.changed event is not observed' },
      ],
    },
  ];

  const unwatched = await check();
  expect(unwatched.observing).toEqual({
    sources: observed,
    watcher: { installed: false, registered: false },
    unwatched: true,
    fix: expect.stringContaining('Run archon workflow wake schedule install.'),
  });
  // A report, not a binding problem: the check still passes.
  expect(unwatched.error).toBeUndefined();

  process.env.ARCHON_HOME = `${archonHome}${sep}`;
  const installedTarget = workflowWakeScheduleTarget();
  await installNativeSchedule(workflowWakeScheduleConfig(), schedules);
  process.env.ARCHON_HOME = archonHome;
  const watched = await check();
  expect(watched.observing).toEqual({
    sources: observed,
    watcher: { installed: true, registered: true },
    unwatched: false,
  });
  expect(watched.error).toBeUndefined();

  // The job discards the watcher's output; a failed last pass is reported, still not an error.
  const lastPass = wakeLastPassPath(installedTarget);
  await mkdir(dirname(lastPass), { recursive: true });
  const failed = {
    at: '2026-11-23T21:30:00.000Z',
    pid: 1,
    ok: false,
    parts: {
      observe: {
        at: '2026-11-23T21:30:00.000Z',
        ok: false,
        errors: ["Webhook source 'github' resolved an unknown run-as user"],
      },
    },
  };
  await writeWakeLastPass(lastPass, failed);
  const failing = await check();
  expect(failing.observing).toEqual({
    sources: observed,
    watcher: { installed: true, registered: true, lastPass: failed },
    unwatched: false,
    problem:
      "The wake watcher runs, but its last pass, at 2026-11-23T21:30:00.000Z, failed: Webhook source 'github' resolved an unknown run-as user.",
  });
  expect(failing.error).toBeUndefined();

  // With the sources file only in the job (passed with --sources), check reads the file the
  // job's watcher recorded.
  delete process.env.ARCHON_WEBHOOK_SOURCES;
  await writeWakeLastPass(lastPass, { ...failed, ok: true, parts: {}, sources });
  expect((await check()).observing).toMatchObject({ sources: observed, unwatched: false });
});

test('finds the registered wake duplicate and its recorded sources and last pass', async () => {
  const { root, archonHome, schedules, registered, check } = await fixture();
  const plugin = join(root, 'duplicate-source.mjs');
  await writeFile(
    plugin,
    `export default () => ({ receive: async () => ({ kind: 'ignored' }), observe: async () => ({ events: [] }) });`
  );
  const sources = join(root, 'duplicate-sources.json');
  await writeFile(
    sources,
    JSON.stringify({
      version: 1,
      sources: [
        {
          sourceInstanceId: 'duplicate',
          module: plugin,
          config: {},
          observe: { everySeconds: 60 },
        },
      ],
    })
  );
  process.env.ARCHON_WEBHOOK_SOURCES = sources;
  const targets = [
    workflowWakeScheduleTarget(archonHome),
    workflowWakeScheduleTarget(`${archonHome}${sep}`),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const [inactive, active] = targets;
  if (!inactive || !active) throw new Error('Expected two wake targets');
  const interval = schedules.platform === 'win32' ? 60 : 5;
  await installNativeSchedule(workflowWakeScheduleConfig(interval, inactive), schedules);
  registered.clear();
  expect((await check()).observing).toMatchObject({
    watcher: { installed: true, registered: false },
    unwatched: true,
  });

  await installNativeSchedule(workflowWakeScheduleConfig(interval, active), schedules);
  const label = scheduleLabel(active.id);
  expect([...registered]).toEqual([schedules.platform === 'win32' ? `\\Archon\\${label}` : label]);
  const pass = { at: '2026-11-27T00:00:00.000Z', pid: 2, ok: true, parts: {}, sources };
  await writeWakeLastPass(wakeLastPassPath(active), pass);
  expect((await check()).observing).toMatchObject({
    watcher: { installed: true, registered: true, lastPass: pass },
    unwatched: false,
  });

  await writeWakeLastPass(wakeLastPassPath(inactive), {
    ...pass,
    pid: 1,
    sources: join(root, 'missing-inactive-sources.json'),
  });
  delete process.env.ARCHON_WEBHOOK_SOURCES;
  const report = await check();
  expect(report.observing).toMatchObject({
    sources: [expect.objectContaining({ source: 'duplicate' })],
    watcher: { installed: true, registered: true, lastPass: pass },
    unwatched: false,
  });
  expect(report.error).toBeUndefined();
});

describe('schedule finds the binding timer however ARCHON_HOME is spelled', () => {
  test('status and reinstall prefer a registered duplicate timer', async () => {
    const { archonHome, alias, config, path, schedule, schedules, registered, scheduled } =
      await scheduleFixture();
    const homes = [archonHome, `${archonHome}${sep}`]
      .map(home => ({
        archonHome: home,
        id: createHash('sha256')
          .update(JSON.stringify([home, 'timer', 'timer']))
          .digest('hex'),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const [inactive, active] = homes;
    if (!inactive || !active) throw new Error('Expected two timer targets');
    const definitions: string[] = [];
    for (const target of [inactive, active]) {
      registered.clear();
      definitions.push(
        (
          await installNativeSchedule(
            {
              ...target,
              workingDirectory: config({ a: 1 }).binding.launch.cwd,
              programArguments: [...cliProgramArguments(), 'trigger', 'fire', '--config', path],
              path: process.env.PATH ?? '',
              schedule: { intervalSeconds: 1800, runAtLoad: false },
              output: 'log',
              removeCommand: `archon trigger schedule remove --config ${path}`,
            },
            schedules
          )
        ).path
      );
    }
    process.env.ARCHON_HOME = alias;
    scheduled.length = 0;
    expect(await schedule('status')).toMatchObject({
      installed: true,
      registered: true,
      path: definitions[1],
    });
    await schedule('install');
    expect(
      scheduled.some(command => command.includes('bootstrap') || command.includes('/Create'))
    ).toBe(false);
  });

  test('status and remove find a timer installed under another spelling of the home', async () => {
    const { archonHome, alias, schedule, timerFiles } = await scheduleFixture();
    process.env.ARCHON_HOME = `${archonHome}${sep}`;
    await schedule('install');
    expect(await timerFiles()).not.toEqual([]);

    process.env.ARCHON_HOME = archonHome;
    expect(await schedule('status')).toMatchObject({ installed: true });
    process.env.ARCHON_HOME = alias;
    expect(await schedule('status')).toMatchObject({ installed: true });
    expect(await schedule('remove')).toMatchObject({ removed: true });
    expect(await timerFiles()).toEqual([]);
    expect(await schedule('status')).toMatchObject({ installed: false });
  });

  test('install under another spelling keeps the one timer the binding has', async () => {
    const { archonHome, alias, schedule, timerFiles } = await scheduleFixture();
    process.env.ARCHON_HOME = `${archonHome}${sep}`;
    await schedule('install');
    const installed = await timerFiles();

    for (const spelling of [`${archonHome}${sep}`, archonHome, alias]) {
      process.env.ARCHON_HOME = spelling;
      await schedule('install');
      expect(await timerFiles()).toEqual(installed);
    }
  });

  test('remove with no timer installed says nothing was removed', async () => {
    const { schedule } = await scheduleFixture();
    expect(await schedule('remove')).toMatchObject({ removed: false });
  });
});
