/**
 * Windows: a Task Scheduler task under `\Archon\`. A task has no environment of its own, so
 * it runs a `.cmd` wrapper that sets `ARCHON_HOME` and `PATH` before the command. The task
 * starts the wrapper through archon's schedule launcher, which keeps every window the tick
 * opens off the operator's screen (`windows-hidden-desktop.ts`).
 */
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { cliProgramArguments } from '../utils/cli-program-arguments';
import {
  installedLabels,
  readInstalled,
  type InstalledJob,
  type NativeScheduleOptions,
  type RunCommand,
  type ScheduleBackend,
  type ScheduledJob,
} from './native-schedule';

const SCHTASKS = 'schtasks.exe';
/** Task Scheduler's repetition interval range. */
const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 31 * 24 * 60 * 60;

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** cmd cannot quote a `"`, and a line break would end the command. */
function cmdValue(value: string): string {
  if (/["\r\n\0]/.test(value)) {
    throw new Error(
      'A Task Scheduler schedule value must not contain a double quote, line break or NUL character'
    );
  }
  return value.replaceAll('%', '%%');
}

/** Windows argv quoting: backslashes before the closing quote would escape it. */
function cmdArgument(value: string): string {
  return `"${cmdValue(value).replace(/(\\+)$/, '$1$1')}"`;
}

function taskName(label: string): string {
  return `\\Archon\\${label}`;
}

function wrapperPath(archonHome: string, label: string): string {
  return join(archonHome, 'schedules', `${label}.cmd`);
}

function definitionPath(archonHome: string, label: string): string {
  return join(archonHome, 'schedules', `${label}.xml`);
}

export function renderTaskWrapper(job: ScheduledJob): string {
  const command = job.programArguments.map(cmdArgument).join(' ');
  const output = job.output === 'log' ? `>> ${cmdArgument(job.log)} 2>&1` : '>nul 2>&1';
  // chcp runs before PATH is replaced and lets cmd read the UTF-8 lines that follow.
  return [
    '@echo off',
    'chcp 65001 >nul',
    `set "ARCHON_HOME=${cmdValue(job.archonHome)}"`,
    `set "PATH=${cmdValue(job.path)}"`,
    `(cd /d ${cmdArgument(job.workingDirectory)} && ${command}) ${output}`,
    '',
  ].join('\r\n');
}

/** The inverse of `cmdArgument`, given the text between its quotes. */
function cmdArgumentValue(quoted: string): string {
  return quoted.replace(/(\\+)$/, run => run.slice(run.length / 2)).replaceAll('%%', '%');
}

/** The inverse of `renderTaskWrapper` for what check needs; undefined for any other file. */
export function readTaskWrapper(wrapper: string): InstalledJob | undefined {
  const lines = wrapper.split('\r\n');
  const home = lines
    .map(line => /^set "ARCHON_HOME=(.*)"$/.exec(line)?.[1])
    .find(value => value !== undefined);
  const command = lines
    .map(line => /^\(cd \/d "[^"]*" && (.*)\) (?:>> "[^"]*" 2>&1|>nul 2>&1)$/.exec(line)?.[1])
    .find(value => value !== undefined);
  if (home === undefined || command === undefined) return undefined;
  return {
    archonHome: home.replaceAll('%%', '%'),
    programArguments: [...command.matchAll(/"([^"]*)"/g)].map(match => cmdArgumentValue(match[1])),
  };
}

export function renderTaskDefinition(
  job: ScheduledJob,
  userId: string,
  launcher: readonly [string, ...string[]]
): string {
  const seconds = job.schedule.intervalSeconds;
  if (seconds % 60 !== 0 || seconds < MIN_INTERVAL_SECONDS || seconds > MAX_INTERVAL_SECONDS) {
    throw new Error(
      `Task Scheduler repeats a task every whole number of minutes from 1 minute to 31 days; ${String(seconds)} seconds is not one.`
    );
  }
  // Task Scheduler expands %NAME% in the action's arguments, and there is no escape for it.
  if (job.archonHome.includes('%')) {
    throw new Error('A Task Scheduler schedule cannot use an ARCHON_HOME that contains %');
  }
  if (launcher.some(argument => argument.includes('%'))) {
    throw new Error('A Task Scheduler schedule cannot run an archon whose path contains %');
  }
  const user = escapeXml(userId);
  const launch = [...launcher, '--internal-schedule-launch', wrapperPath(job.archonHome, job.label)]
    .map(argument => escapeXml(cmdArgument(argument)))
    .join(' ');
  const logon = job.schedule.runAtLoad
    ? `
    <LogonTrigger><UserId>${user}</UserId><Enabled>true</Enabled></LogonTrigger>`
    : '';
  // A fixed past StartBoundary keeps the rendering identical across installs. The settings
  // match launchd: no overlapping runs, no time limit, no replay of missed runs, and runs on
  // battery. InteractiveToken runs as the logged-on user, so the Credential Manager that gh
  // and Git Credential Manager use stays readable. The action is the launcher under
  // `conhost --headless`, so the tick's first console has no window; the launcher puts the
  // wrapper, and everything the run starts, on a desktop nobody looks at.
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Archon schedule ${escapeXml(job.label)}</Description></RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>2000-01-01T00:00:00</StartBoundary>
      <Repetition><Interval>PT${String(seconds / 60)}M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <Enabled>true</Enabled>
    </TimeTrigger>${logon}
  </Triggers>
  <Principals><Principal id="Author"><UserId>${user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>false</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec>
    <Command>%SystemRoot%\\System32\\conhost.exe</Command>
    <Arguments>--headless ${launch}</Arguments>
  </Exec></Actions>
</Task>
`;
}

/** The encoding the XML declares, with a byte-order mark, as Task Scheduler exports it. */
function utf16le(value: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(value, 'utf16le')]);
}

function defaultUserId(): string {
  const { username } = userInfo();
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${username}` : username;
}

export function taskSchedulerBackend(
  run: RunCommand,
  archonHome: string,
  options: NativeScheduleOptions
): ScheduleBackend {
  const isRegistered = (label: string): Promise<boolean> =>
    run(SCHTASKS, ['/Query', '/TN', taskName(label)]).then(
      () => true,
      () => false
    );
  const deleteTask = (label: string): Promise<void> =>
    run(SCHTASKS, ['/Delete', '/TN', taskName(label), '/F']);

  return {
    scheduler: 'Task Scheduler',
    filePaths: label => [definitionPath(archonHome, label), wrapperPath(archonHome, label)],
    render: job => [
      {
        path: definitionPath(archonHome, job.label),
        contents: utf16le(
          renderTaskDefinition(
            job,
            options.windowsUserId ?? defaultUserId(),
            options.windowsLauncher ?? cliProgramArguments()
          )
        ),
      },
      { path: wrapperPath(archonHome, job.label), contents: renderTaskWrapper(job) },
    ],
    isRegistered,
    register: async job => {
      const name = taskName(job.label);
      await run(SCHTASKS, [
        '/Create',
        '/TN',
        name,
        '/XML',
        definitionPath(archonHome, job.label),
        '/F',
      ]);
      if (!job.schedule.runAtLoad) return;
      try {
        await run(SCHTASKS, ['/Run', '/TN', name]);
      } catch (error) {
        // Install rolls back the files it wrote; the task must go with them.
        await deleteTask(job.label).catch(() => undefined);
        throw error;
      }
    },
    unregister: async label => {
      if (await isRegistered(label)) await deleteTask(label);
    },
    installed: async () =>
      readInstalled(
        await installedLabels(join(archonHome, 'schedules'), '.cmd'),
        label => wrapperPath(archonHome, label),
        readTaskWrapper,
        label =>
          `${SCHTASKS} /Delete /TN ${taskName(label)} /F, then delete ${definitionPath(archonHome, label)} and ${wrapperPath(archonHome, label)}`
      ),
  };
}
