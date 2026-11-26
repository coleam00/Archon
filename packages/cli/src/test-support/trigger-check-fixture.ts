import { afterEach } from 'bun:test';
import { mkdir, mkdtemp, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { providerRegistry } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { loadConfig } from '@archon/core/config/config-loader';
import { setPlatformPolicies } from '@archon/core/platforms/registry';
import { createWorkflowOperations } from '@archon/core/operations/workflow-operations';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import { createInMemoryWorkflowHostStore, createInMemoryWorkflowStore } from './workflow-store';
import { installNativeSchedule, type NativeScheduleOptions } from '../triggers/native-schedule';
import { triggerCommand } from '../commands/trigger';
import { spyOnJsonStdout } from './workflow-harness-output';

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

export async function triggerCheckFixture() {
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
  const installTimer = async (path: string): Promise<string> => {
    const installed = await installNativeSchedule(
      {
        id: 'timer',
        programArguments: ['/opt/archon/bin/archon', 'trigger', 'fire', '--config', path],
        workingDirectory: project,
        archonHome,
        path: '/usr/bin:/bin',
        schedule: { intervalSeconds: 1800, runAtLoad: false },
        output: 'log',
        removeCommand: `archon trigger schedule remove --config ${path}`,
      },
      schedules
    );
    return installed.path;
  };
  const check = async (): Promise<{
    bindings: CheckedBinding[];
    observing?: Record<string, unknown>;
    error: unknown;
  }> => {
    const stdout = spyOnJsonStdout();
    try {
      const error: unknown = await triggerCommand(
        hostForTest(),
        'check',
        [],
        {},
        { schedules }
      ).then(
        () => undefined,
        caught => caught
      );
      // The check prints one pretty JSON document; log lines are single-line.
      const printed =
        stdout.mock.calls
          .map(([chunk]: readonly unknown[]) => String(chunk))
          .findLast(chunk => chunk.startsWith('{\n')) ?? '';
      if (printed === '') throw error;
      return {
        ...(JSON.parse(printed) as {
          bindings: CheckedBinding[];
          observing?: Record<string, unknown>;
        }),
        error,
      };
    } finally {
      stdout.mockRestore();
    }
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

export async function triggerScheduleFixture() {
  const base = await triggerCheckFixture();
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
    const stdout = spyOnJsonStdout();
    try {
      await triggerCommand(
        host,
        'schedule',
        [operation],
        { config: path },
        { schedules: base.schedules }
      );
      const printed = stdout.mock.calls
        .map(([chunk]: readonly unknown[]) => String(chunk))
        .join('');
      return JSON.parse(printed) as Record<string, unknown>;
    } finally {
      stdout.mockRestore();
    }
  };
  const timerFiles = async (): Promise<string[]> =>
    (await readdir(dirname(base.timerPrefix))).filter(name =>
      name.startsWith(basename(base.timerPrefix))
    );
  return { ...base, path, alias, schedule, timerFiles };
}
