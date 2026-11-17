/**
 * `archon tracker`: bring the item tracker up to date without a running server, and let
 * go of a pass whose holder this host cannot prove gone.
 */
import {
  hostItemTrackerForge,
  ItemTracker,
  itemTrackerDestinationId,
  type PassWrites,
  type TrackerPassReport,
} from '@archon/adapters/item-tracker/item-tracker';
import { loadConfig } from '@archon/core/config/config-loader';
import { releaseTrackerPass } from '@archon/core/db/item-tracker';
import { writeStdout } from '../utils/stdout';

/** The configured tracker, activated; undefined when the config tracks no project. */
export async function activateConfiguredTracker(
  forgeTrustedEnv: NodeJS.ProcessEnv
): Promise<ItemTracker | undefined> {
  const { itemTracker } = await loadConfig();
  if (!itemTracker) return undefined;
  const tracker = new ItemTracker(itemTracker, hostItemTrackerForge(forgeTrustedEnv));
  await tracker.activate();
  return tracker;
}

/**
 * `tracker sync`'s pass over every tracked project, asking a project's holder for one more
 * when another process holds it, because this process does not come back. Undefined when
 * the config tracks no project.
 */
export async function syncConfiguredProjects(
  forgeTrustedEnv: NodeJS.ProcessEnv
): Promise<TrackerPassReport[] | undefined> {
  return (await activateConfiguredTracker(forgeTrustedEnv))?.scan({ request: true });
}

/**
 * Exits 1 only when a tracked project could not be scanned at all: misconfigured, or its
 * pass failed. A project another live pass holds is not a failure: that holder runs the
 * pass this one asked for.
 */
export async function trackerSyncCommand(options: {
  json: boolean;
  sync: () => Promise<TrackerPassReport[] | undefined>;
  stdout?: typeof writeStdout;
}): Promise<number> {
  const stdout = options.stdout ?? writeStdout;
  const projects = await options.sync();
  const ok = (projects ?? []).every(
    project => project.outcome === 'scanned' || project.outcome === 'held'
  );
  if (options.json) await stdout(`${JSON.stringify({ ok, projects: projects ?? [] }, null, 2)}\n`);
  else if (!projects)
    await stdout('No project is tracked: the Archon config has no itemTracker block.\n');
  else await stdout(projects.map(reportLines).join(''));
  return ok ? 0 : 1;
}

function reportLines(report: TrackerPassReport): string {
  const { project } = report;
  switch (report.outcome) {
    case 'scanned':
      return writeLines(`${project}:`, report);
    case 'held':
      return (
        `${project}: held by ${report.heldBy.host}:${String(report.heldBy.pid)} since ${report.since}; ` +
        `that process runs one more pass. If it is gone, run: archon tracker release ${project}\n`
      );
    case 'misconfigured':
      return `${project}: misconfigured (${[report.errorKind, ...(report.unsupported ?? [])].join(': ')})\n`;
    case 'failed':
      return writeLines(`${project}: failed: ${report.error};`, report);
  }
}

function writeLines(head: string, { posted, notPosted }: PassWrites): string {
  return [
    `${head} posted ${String(posted.length)}, not posted ${String(notPosted.length)}\n`,
    ...notPosted.map(
      missed =>
        `  ${missed.item}: ${missed.errorKind}${missed.retried ? ', the next pass retries it' : ''}\n`
    ),
  ].join('');
}

/**
 * Let go of a tracked project's pass for a holder this host cannot prove gone, such as a
 * process on another host. Refuses a holder on this host that is still running.
 */
export async function trackerReleaseCommand(
  project: string,
  options: { json: boolean; stdout?: typeof writeStdout }
): Promise<number> {
  const stdout = options.stdout ?? writeStdout;
  const tracked = (await loadConfig()).itemTracker?.projects.some(p => p.project === project);
  if (!tracked) {
    await stdout(
      options.json
        ? `${JSON.stringify({ ok: false, project, error: 'not_tracked' }, null, 2)}\n`
        : `${project} is not a tracked project in the itemTracker config.\n`
    );
    return 1;
  }
  const outcome = await releaseTrackerPass(itemTrackerDestinationId(project));
  const ok = outcome !== 'owner_running';
  if (options.json) await stdout(`${JSON.stringify({ ok, project, outcome }, null, 2)}\n`);
  else
    await stdout(
      {
        released: `Released the pass on ${project}.\n`,
        not_held: `No pass holds ${project}.\n`,
        owner_running: `Refused: the process holding ${project} is running on this host.\n`,
      }[outcome]
    );
  return ok ? 0 : 1;
}
