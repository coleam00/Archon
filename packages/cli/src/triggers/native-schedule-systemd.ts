/** Linux: a systemd user timer and the oneshot service it starts. */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type {
  NativeScheduleOptions,
  RunCommand,
  ScheduleBackend,
  ScheduledJob,
} from './native-schedule';

const SYSTEMCTL = 'systemctl';

/** Every unit-file value: `%` starts a specifier, and a line break would end the setting. */
function unitValue(value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error('A systemd schedule value must not contain a line break or NUL character');
  }
  return value.replaceAll('%', '%%');
}

function quoted(value: string): string {
  return `"${unitValue(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function renderSystemdUnits(job: ScheduledJob): { service: string; timer: string } {
  // ExecStart expands $NAME; `$$` is a literal dollar sign.
  const execStart = job.programArguments.map(arg => quoted(arg).replaceAll('$', '$$$$')).join(' ');
  const output = job.output === 'log' ? `append:${unitValue(job.log)}` : 'null';
  const interval = `${String(job.schedule.intervalSeconds)}s`;
  const description = `Description=Archon schedule ${job.label}`;
  return {
    service: `[Unit]
${description}

[Service]
Type=oneshot
# trigger fire hands its run to a detached child; the default control-group kill would end it when fire exits.
KillMode=process
WorkingDirectory=${unitValue(job.workingDirectory)}
Environment=${quoted(`ARCHON_HOME=${job.archonHome}`)}
Environment=${quoted(`PATH=${job.path}`)}
ExecStart=${execStart}
StandardOutput=${output}
StandardError=${output}
`,
    // OnActiveSec is what fires the first run: OnUnitActiveSec counts from a run that has
    // not happened yet. AccuracySec=1s keeps the default one-minute slack off short intervals.
    timer: `[Unit]
${description}

[Timer]
OnActiveSec=${job.schedule.runAtLoad ? '1s' : interval}
OnUnitActiveSec=${interval}
AccuracySec=1s

[Install]
WantedBy=timers.target
`,
  };
}

function userUnitDirectory(): string {
  const configHome = process.env.XDG_CONFIG_HOME;
  return join(
    configHome && isAbsolute(configHome) ? configHome : join(homedir(), '.config'),
    'systemd',
    'user'
  );
}

export function systemdBackend(run: RunCommand, options: NativeScheduleOptions): ScheduleBackend {
  const directory = options.systemdUserDirectory ?? userUnitDirectory();
  const timer = (label: string): string => `${label}.timer`;
  const paths = (label: string): [string, string] => [
    join(directory, timer(label)),
    join(directory, `${label}.service`),
  ];
  const systemctl = (...args: string[]): Promise<void> => run(SYSTEMCTL, ['--user', ...args]);

  return {
    scheduler: 'systemctl --user',
    filePaths: paths,
    render: job => {
      const [timerPath, servicePath] = paths(job.label);
      const units = renderSystemdUnits(job);
      return [
        { path: timerPath, contents: units.timer },
        { path: servicePath, contents: units.service },
      ];
    },
    probe: () => systemctl('show-environment'),
    isRegistered: label =>
      systemctl('is-active', '--quiet', timer(label)).then(
        () => true,
        () => false
      ),
    register: async job => {
      await systemctl('daemon-reload');
      await systemctl('enable', '--now', timer(job.label));
    },
    unregister: label => systemctl('disable', '--now', timer(label)),
    afterRemove: () => systemctl('daemon-reload'),
  };
}
