/** macOS: a per-user LaunchAgent in the GUI domain. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  installedLabels,
  readInstalled,
  type InstalledJob,
  type NativeScheduleOptions,
  type RunCommand,
  type ScheduleBackend,
  type ScheduledJob,
} from './native-schedule';

const LAUNCHCTL = '/bin/launchctl';

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function unescapeXml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name]);
}

function xmlString(value: string): string {
  return `<string>${escapeXml(value)}</string>`;
}

export function renderMacosLaunchAgent(job: ScheduledJob): string {
  const programArguments = job.programArguments
    .map(argument => `      ${xmlString(argument)}`)
    .join('\n');
  // launchd creates and appends to these files; without them it discards the output.
  const output =
    job.output === 'log'
      ? `    <key>StandardOutPath</key>
    ${xmlString(job.log)}
    <key>StandardErrorPath</key>
    ${xmlString(job.log)}
`
      : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    ${xmlString(job.label)}
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
    <key>WorkingDirectory</key>
    ${xmlString(job.workingDirectory)}
    <key>EnvironmentVariables</key>
    <dict>
      <key>ARCHON_HOME</key>
      ${xmlString(job.archonHome)}
      <key>PATH</key>
      ${xmlString(job.path)}
    </dict>
    <key>StartInterval</key>
    <integer>${String(job.schedule.intervalSeconds)}</integer>
    <key>RunAtLoad</key>
    <${job.schedule.runAtLoad ? 'true' : 'false'}/>
${output}  </dict>
</plist>
`;
}

/** The inverse of `renderMacosLaunchAgent` for what check needs; undefined for any other plist. */
export function readMacosLaunchAgent(plist: string): InstalledJob | undefined {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1];
  const home = /<key>ARCHON_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
  if (array === undefined || home === undefined) return undefined;
  const programArguments = [...array.matchAll(/<string>([^<]*)<\/string>/g)].map(match =>
    unescapeXml(match[1])
  );
  return { archonHome: unescapeXml(home), programArguments };
}

export function launchdBackend(run: RunCommand, options: NativeScheduleOptions): ScheduleBackend {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error('Cannot determine the macOS user launchd domain');
  const domain = `gui/${String(uid)}`;
  const directory = options.launchAgentsDirectory ?? join(homedir(), 'Library', 'LaunchAgents');
  const plistPath = (label: string): string => join(directory, `${label}.plist`);
  const isRegistered = async (label: string): Promise<boolean> =>
    run(LAUNCHCTL, ['print', `${domain}/${label}`]).then(
      () => true,
      () => false
    );

  return {
    scheduler: 'launchd',
    filePaths: label => [plistPath(label)],
    render: job => [{ path: plistPath(job.label), contents: renderMacosLaunchAgent(job) }],
    isRegistered,
    register: job => run(LAUNCHCTL, ['bootstrap', domain, plistPath(job.label)]),
    installed: async matchesLabel =>
      readInstalled(
        await installedLabels(directory, '.plist'),
        plistPath,
        readMacosLaunchAgent,
        label => `${LAUNCHCTL} bootout ${domain}/${label}, then delete ${plistPath(label)}`,
        matchesLabel
      ),
    // bootout fails for a plist launchd has not loaded, which would strand its file.
    unregister: async label => {
      if (await isRegistered(label)) await run(LAUNCHCTL, ['bootout', domain, plistPath(label)]);
    },
  };
}
