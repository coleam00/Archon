// @archon-test-isolated
// @archon-test-windows
/**
 * `archon trigger check` reads the bindings this install can start, wherever a timer's
 * config lives, and reports a start that would be refused for its inputs, reading only.
 * `trigger schedule` finds the timer it installed by the same reading of `ARCHON_HOME`.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { providerRegistry } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { loadConfig } from '@archon/core/config/config-loader';
import { setPlatformPolicies } from '@archon/core/platforms/registry';
import { createWorkflowOperations } from '@archon/core/operations/workflow-operations';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import {
  createInMemoryWorkflowHostStore,
  createInMemoryWorkflowStore,
} from '../test-support/workflow-store';
import { installNativeSchedule, type NativeScheduleOptions } from '../triggers/native-schedule';
import { triggerCommand } from './trigger';
import { wakeLastPassPath, workflowWakeScheduleConfig, writeWakeLastPass } from './wake-schedule';

const tempRoots = trackTempRoots();
const previousHome = process.env.ARCHON_HOME;
const previousSources = process.env.ARCHON_WEBHOOK_SOURCES;

afterEach(() => {
  if (previousHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousHome;
  if (previousSources === undefined) delete process.env.ARCHON_WEBHOOK_SOURCES;
  else process.env.ARCHON_WEBHOOK_SOURCES = previousSources;
});

function hostForTest(): WorkflowHost {
  const records = createInMemoryWorkflowHostStore();
  const store = createInMemoryWorkflowStore(records);
  const deps = {
    store,
    providers: providerRegistry,
    loadConfig,
    getAgentProvider: (): never => {
      throw new Error('No AI provider');
    },
  };
  const unsupported = async (): Promise<never> => {
    throw new Error('Unexpected host effect');
  };
  return {
    deps,
    records,
    engine: new InProcessWorkflowEngine(deps),
    operations: createWorkflowOperations({
      store: { ...store, deleteWorkflowRun: unsupported },
      hostStore: records,
      getUserRole: async id => (await records.users.getUserById(id))?.role,
      requestDetachedRunStop: unsupported,
      isRunOwnedByThisProcess: () => false,
      isRunOwnerAnswering: async () => false,
      reclaimRunWorktree: unsupported,
      reclaimContainerEnv: unsupported,
    }),
  };
}

// `a` is required, `b` is not declared.
const WORKFLOW =
  'name: stage\ndescription: A stage\ninputs:\n  a: { required: true }\nnodes:\n  - id: one\n    bash: echo one\n';

interface CheckedBinding {
  file: string;
  workflowName: string | null;
  timer: string | null;
  problems: string[];
}

async function fixture() {
  const root = tempRoots(await realpath(await mkdtemp(join(tmpdir(), 'archon-trigger-check-'))));
  const project = join(root, 'project');
  const archonHome = join(root, 'home');
  await mkdir(join(project, '.archon', 'workflows'), { recursive: true });
  await writeFile(join(project, '.archon', 'workflows', 'stage.yaml'), WORKFLOW);
  await mkdir(join(archonHome, 'triggers'), { recursive: true });
  process.env.ARCHON_HOME = archonHome;
  registerBuiltinProviders();
  setPlatformPolicies([]);
  const scheduled: string[][] = [];
  const runCommand: NativeScheduleOptions['runCommand'] = async (executable, args) => {
    scheduled.push([executable, ...args]);
  };
  // A job is validated by its scheduler's path rules, so the scheduler must be one whose
  // rules accept the host paths this fixture writes: Task Scheduler on Windows, launchd elsewhere.
  const { schedules, timerPrefix, removeByHand } =
    process.platform === 'win32'
      ? {
          schedules: { platform: 'win32', windowsUserId: 'me', runCommand } as const,
          timerPrefix: join(archonHome, 'schedules', 'com.archon.trigger.'),
          removeByHand: 'schtasks.exe /Delete /TN \\Archon\\com.archon.trigger.',
        }
      : {
          schedules: {
            platform: 'darwin',
            uid: 501,
            launchAgentsDirectory: join(root, 'LaunchAgents'),
            runCommand,
          } as const,
          timerPrefix: join(root, 'LaunchAgents', 'com.archon.trigger.'),
          removeByHand: 'launchctl bootout gui/501/com.archon.trigger.',
        };
  const config = (inputs: Record<string, unknown>, schedule = true) => ({
    version: 1,
    sourceInstanceId: 'timer',
    binding: {
      bindingId: 'timer',
      bindingRevision: null,
      hostId: 'host',
      runAsUserId: 'user',
      resource: 'stage',
      overlap: 'queue',
      launch: { cwd: project, workflowName: 'stage', inputs, isolation: { kind: 'in-place' } },
    },
    ...(schedule ? { schedule: { intervalSeconds: 1800, runAtLoad: false } } : {}),
  });
  /** A timer whose config file is outside the triggers directory, as `schedule install` leaves it. */
  const installTimer = async (path: string): Promise<void> => {
    await installNativeSchedule(
      {
        id: 'timer',
        programArguments: ['/opt/archon/bin/archon', 'trigger', 'fire', '--binding', path],
        workingDirectory: project,
        archonHome,
        path: '/usr/bin:/bin',
        schedule: { intervalSeconds: 1800, runAtLoad: false },
        output: 'log',
        removeCommand: `archon trigger schedule remove --binding ${path}`,
      },
      schedules
    );
  };
  const check = async (): Promise<{
    bindings: CheckedBinding[];
    observing?: Record<string, unknown>;
    error: unknown;
  }> => {
    let printed = '';
    const stdout = spyOn(process.stdout, 'write').mockImplementation(((
      chunk: unknown,
      encodingOrCallback?: unknown,
      callback?: () => void
    ) => {
      // The check prints one pretty JSON document; log lines are single-line.
      if (String(chunk).startsWith('{\n')) printed = String(chunk);
      (typeof encodingOrCallback === 'function'
        ? (encodingOrCallback as () => void)
        : callback)?.();
      return true;
    }) as typeof process.stdout.write);
    let error: unknown;
    try {
      await triggerCommand(hostForTest(), 'check', [], {}, { schedules });
    } catch (caught) {
      error = caught;
    } finally {
      stdout.mockRestore();
    }
    if (printed === '') throw error;
    return {
      ...(JSON.parse(printed) as {
        bindings: CheckedBinding[];
        observing?: Record<string, unknown>;
      }),
      error,
    };
  };
  return {
    root,
    archonHome,
    config,
    installTimer,
    check,
    scheduled,
    schedules,
    timerPrefix,
    removeByHand,
  };
}

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
  const { root, check, schedules } = await fixture();
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

  await installNativeSchedule(workflowWakeScheduleConfig(), schedules);
  const watched = await check();
  expect(watched.observing).toEqual({
    sources: observed,
    watcher: { installed: true, registered: true },
    unwatched: false,
  });
  expect(watched.error).toBeUndefined();

  // The job discards the watcher's output; a failed last pass is reported, still not an error.
  const lastPass = wakeLastPassPath();
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

describe('schedule finds the binding timer however ARCHON_HOME is spelled', () => {
  async function scheduleFixture() {
    const base = await fixture();
    const host = hostForTest();
    const user = await host.records.users.findOrCreateUserByPlatformIdentity('cli', 'me');
    if (!user) throw new Error('No run-as user');
    const path = join(base.root, 'timer.json');
    const timerConfig = base.config({ a: 1 });
    timerConfig.binding.runAsUserId = user.id;
    await writeFile(path, JSON.stringify(timerConfig));
    const alias = join(base.root, 'home-link');
    await symlink(base.archonHome, alias, 'junction');
    const schedule = async (operation: string): Promise<Record<string, unknown>> => {
      let printed = '';
      const stdout = spyOn(process.stdout, 'write').mockImplementation(((
        chunk: unknown,
        encodingOrCallback?: unknown,
        callback?: () => void
      ) => {
        printed += String(chunk);
        (typeof encodingOrCallback === 'function'
          ? (encodingOrCallback as () => void)
          : callback)?.();
        return true;
      }) as typeof process.stdout.write);
      try {
        await triggerCommand(
          host,
          'schedule',
          [operation],
          { binding: path },
          { schedules: base.schedules }
        );
      } finally {
        stdout.mockRestore();
      }
      return JSON.parse(printed) as Record<string, unknown>;
    };
    const timerFiles = async (): Promise<string[]> =>
      (await readdir(dirname(base.timerPrefix))).filter(name =>
        name.startsWith(basename(base.timerPrefix))
      );
    return { ...base, path, alias, schedule, timerFiles };
  }

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
