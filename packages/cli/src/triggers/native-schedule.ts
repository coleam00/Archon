import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

export const MACOS_TRIGGER_JOB_LABEL_PREFIX = 'com.archon.trigger.';

export interface NativeScheduleConfig {
  id: string;
  programArguments: readonly [string, ...string[]];
  workingDirectory: string;
  archonHome: string;
  schedule: {
    intervalSeconds: number;
    runAtLoad: boolean;
  };
}

export interface RenderedMacosLaunchAgent {
  label: string;
  plist: string;
}

export interface NativeScheduleOptions {
  platform?: NodeJS.Platform;
  uid?: number;
  launchAgentsDirectory?: string;
  runCommand?: (executable: string, args: readonly string[]) => Promise<void>;
}

const execFileAsync = promisify(execFile);
const OWNED_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function jobLabel(id: string): string {
  if (!OWNED_ID.test(id)) {
    throw new Error(
      'Native schedule id must start and end with a letter or digit and contain only letters, digits, dots, underscores, or hyphens'
    );
  }
  return `${MACOS_TRIGGER_JOB_LABEL_PREFIX}${id}`;
}

function assertAbsolute(name: string, value: string): void {
  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
}

export function renderMacosLaunchAgent(config: NativeScheduleConfig): RenderedMacosLaunchAgent {
  const label = jobLabel(config.id);
  const [executable, ...args] = config.programArguments;
  assertAbsolute('Native schedule executable', executable);
  assertAbsolute('Native schedule working directory', config.workingDirectory);
  assertAbsolute('Native schedule ARCHON_HOME', config.archonHome);

  if (config.programArguments.some(argument => argument.length === 0)) {
    throw new Error('Native schedule program arguments must not be empty');
  }
  if (
    !Number.isSafeInteger(config.schedule.intervalSeconds) ||
    config.schedule.intervalSeconds <= 0
  ) {
    throw new Error('Native schedule intervalSeconds must be a positive integer');
  }
  if (typeof config.schedule.runAtLoad !== 'boolean') {
    throw new Error('Native schedule runAtLoad must be a boolean');
  }

  const programArguments = [executable, ...args]
    .map(argument => `      <string>${escapeXml(argument)}</string>`)
    .join('\n');

  return {
    label,
    plist: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(config.workingDirectory)}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>ARCHON_HOME</key>
      <string>${escapeXml(config.archonHome)}</string>
    </dict>
    <key>StartInterval</key>
    <integer>${String(config.schedule.intervalSeconds)}</integer>
    <key>RunAtLoad</key>
    <${config.schedule.runAtLoad ? 'true' : 'false'}/>
  </dict>
</plist>
`,
  };
}

function resolveRuntime(options: NativeScheduleOptions): {
  directory: string;
  domain: string;
  runCommand: NonNullable<NativeScheduleOptions['runCommand']>;
} {
  if ((options.platform ?? process.platform) !== 'darwin') {
    throw new Error(
      'Native schedule installation is supported only on macOS. Use the documented systemd, cron, or Task Scheduler command recipe on this host.'
    );
  }

  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) {
    throw new Error('Cannot determine the macOS user launchd domain');
  }

  return {
    directory: options.launchAgentsDirectory ?? join(homedir(), 'Library', 'LaunchAgents'),
    domain: `gui/${String(uid)}`,
    runCommand:
      options.runCommand ??
      (async (executable, args): Promise<void> => {
        await execFileAsync(executable, [...args]);
      }),
  };
}

async function writeOwnedConfiguration(path: string, contents: string): Promise<boolean> {
  try {
    const existing = await readFile(path, 'utf8');
    if (existing !== contents) {
      throw new Error(
        `Refusing to replace an existing native schedule with different configuration: ${path}`
      );
    }
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    await link(temporaryPath, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readFile(path, 'utf8');
    if (existing !== contents) {
      throw new Error(
        `Refusing to replace an existing native schedule with different configuration: ${path}`
      );
    }
    return false;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return true;
}

export async function installMacosNativeSchedule(
  config: NativeScheduleConfig,
  options: NativeScheduleOptions = {}
): Promise<string> {
  const rendered = renderMacosLaunchAgent(config);
  const runtime = resolveRuntime(options);
  await mkdir(runtime.directory, { recursive: true, mode: 0o700 });
  const path = join(runtime.directory, `${rendered.label}.plist`);
  const created = await writeOwnedConfiguration(path, rendered.plist);
  if (!created) return path;

  try {
    await runtime.runCommand('/bin/launchctl', ['bootstrap', runtime.domain, path]);
  } catch (error) {
    await unlink(path).catch(() => undefined);
    throw error;
  }
  return path;
}

export async function removeMacosNativeSchedule(
  id: string,
  options: NativeScheduleOptions = {}
): Promise<boolean> {
  const label = jobLabel(id);
  const runtime = resolveRuntime(options);
  const path = join(runtime.directory, `${label}.plist`);
  try {
    await access(path, constants.F_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }

  await runtime.runCommand('/bin/launchctl', ['bootout', runtime.domain, path]);
  await unlink(path);
  return true;
}
