/**
 * The start-time refusal for a run whose pack declares `forge:` in its `.pack/pack.yaml`.
 *
 * Every fresh start path calls {@link assertRunForgeAccess} beside its credential
 * preflight, before a worktree, a slot or a node: the CLI, chat and Web dispatch, the
 * resume menu's fresh run, a trigger binding before admission, and a `workflow:` sub-run. Continuations are not
 * checked; a paused run's forge calls still refuse on their own.
 *
 * The check asks `archon forge check` through `ARCHON_CLI_COMMAND`, the same executable,
 * plugin discovery and credential reading the run's own forge calls use, so the check and
 * the run cannot disagree about which plugin serves a remote. Each check makes one read of
 * the repository with the run's credential and no write, when the plugin advertises
 * `pr.view`.
 */
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  cliForgeResponseSchema,
  type ForgeAccessRefusalKind,
  isForgeAccessRefusalKind,
} from '@archon/forge';
import { execFileAsync, GitFailure } from '@archon/git';
import { createLogger } from '@archon/paths';
import { RUN_GITHUB_IDENTITY_HANDOFF_ENV } from '@archon/paths/github-token-env';
import type { WorkflowEnvironment } from './deps';
import type { JsonValue } from './output-ref';
import { resolveRunStartInputs } from './pack-settings';
import { resolveWorkflowGithubEnvironment, type WorkflowGithubDeps } from './run-credential-env';
import type { ForgeRefusalFailure } from './schemas/resource-start';
import type { ResolvedWorkflow } from './schemas/workflow';

const log = createLogger('workflow.run-forge-access');

const CHECK_TIMEOUT_MS = 30_000;

/**
 * Why a run cannot reach the forge its pack needs. The forge's own refusals pass through;
 * `no_forge_path`, `no_forge_remote` and `no_forge_repository` are the run's;
 * `check_failed` is a check that could not answer, which refuses too, because the run's
 * forge calls would fail alike.
 */
export type ForgeRequirementReason =
  | 'no_forge_path'
  | 'no_forge_remote'
  | 'no_forge_repository'
  | ForgeAccessRefusalKind
  | 'check_failed';

/** The stored failure, with `reason` narrowed to the reasons this engine produces. */
export type ForgeRequirementFailure = Readonly<
  Omit<ForgeRefusalFailure, 'reason'> & { reason: ForgeRequirementReason }
>;

export class ForgeRequirementError extends Error {
  constructor(
    workflowName: string,
    readonly packKey: string,
    readonly failures: readonly ForgeRequirementFailure[],
    /** The repository the run names, when it was checked instead of the remotes. */
    repository?: ForgeRepository
  ) {
    const where =
      repository === undefined ? '' : `Repository '${repository.host}/${repository.path}': `;
    super(
      `Workflow '${workflowName}' cannot start: pack '${packKey}' needs a forge this run cannot reach. ` +
        where +
        failures.map(describeFailure).join(' ') +
        ' No worktree was created and no AI cost was incurred.'
    );
    this.name = 'ForgeRequirementError';
  }
}

function describeFailure(failure: ForgeRequirementFailure): string {
  const where = failure.remote === undefined ? '' : `Remote '${failure.remote}': `;
  const remedy = failure.remedy === undefined ? '' : ` ${failure.remedy}`;
  return `${where}${failure.message} (${failure.reason}).${remedy}`;
}

export interface ForgeRepository {
  readonly host: string;
  readonly path: string;
}

/** The start inputs, by name, whose values name the repository a run acts on. */
export type ForgeRepositoryInputs = Readonly<Record<string, string>>;

/** What one `forge check` asks about: a remote of the checkout, or the repository the run names. */
export type ForgeCheckRequest = ({ remote: string } | { repo: ForgeRepository }) & {
  operations: readonly string[];
};

/** One `forge check` answer: `undefined` when the forge can serve the run. */
export type ForgeCheck = (
  request: ForgeCheckRequest,
  context: { cliCommand: readonly string[]; env: NodeJS.ProcessEnv; cwd: string }
) => Promise<Omit<ForgeRequirementFailure, 'remote'> | undefined>;

/** Where the run starts: its checkout, and whether it executes in a container. */
export interface RunForgeAccessSite {
  /** The project checkout the run is cut from; a worktree of it has the same remotes. */
  readonly cwd: string;
  /**
   * The checkout whose `.archon/packs/` settings the run starts with: the one its other
   * start preflights read configuration from, such as an adopted worktree. It may hold
   * settings that name a different repository than the project checkout's.
   */
  readonly settingsCwd: string;
  readonly codebaseId: string | undefined;
  readonly inContainer?: boolean;
  /**
   * The values the run is started with (`--input`, a binding's inputs, a parent's `with:`).
   * The check merges the pack's settings and the workflow's defaults under them, as the run
   * does at start, before reading the inputs that name its repository (`forge.repository`).
   */
  readonly supplied: Readonly<Record<string, JsonValue>> | undefined;
}

/**
 * Refuse a fresh run whose pack declares forge needs this run cannot meet: the forge must
 * have a plugin that advertises every declared capability, a credential that resolves, and,
 * when the plugin advertises `pr.view`, accept that credential in one read of the
 * repository. The repository is the one the run's start inputs name through the pack's
 * `forge.repository`; when they name none, some remote of the checkout must pass. A run
 * whose pack declares nothing returns at once.
 *
 * @returns the start inputs that name the repository the check judged, or undefined when
 *   it judged the checkout's remotes. The caller supplies them to the run: a run that
 *   executes in a worktree cut after this check reads its settings again from that
 *   worktree, which can name another repository.
 * @throws ForgeRequirementError naming each typed reason and its remedy.
 */
export async function assertRunForgeAccess(
  deps: WorkflowGithubDeps,
  workflow: Pick<ResolvedWorkflow, 'name' | 'pack' | 'inputs'>,
  /** The run's prepared configuration, before its GitHub credential is layered. */
  prepared: { readonly config: WorkflowEnvironment; readonly executionUserId?: string },
  site: RunForgeAccessSite,
  check: ForgeCheck = checkThroughCli
): Promise<ForgeRepositoryInputs | undefined> {
  const { name: workflowName, pack } = workflow;
  const needs = pack?.forge;
  if (pack === undefined || needs === undefined) return undefined;
  const packKey = pack.key;
  function refuse(failures: ForgeRequirementFailure[], repository?: ForgeRepository): never {
    throw new ForgeRequirementError(workflowName, packKey, failures, repository);
  }
  if (site.inContainer === true) {
    refuse([
      {
        reason: 'no_forge_path',
        message: 'a container execution has no host command to reach the forge',
        remedy: 'Run this workflow without container isolation.',
      },
    ]);
  }
  const target = await forgeTarget(workflow, needs.repository, site);
  if ('reason' in target) refuse([target]);
  const cliCommand = hostCliCommand();
  if (cliCommand === undefined) {
    refuse([
      {
        reason: 'no_forge_path',
        message: 'this host publishes no ARCHON_CLI_COMMAND for the forge',
        remedy: 'Start the run through the archon CLI or server, which publish it.',
      },
    ]);
  }
  // The env the run's script nodes call the forge with: the host's, the run's configured
  // env, and the run's GitHub credential (an App installation token, a per-user token or
  // the per-user scrub). The handoff keeps the CLI's env files from replacing that
  // credential, as WORKFLOW_ID does for the run's own forge calls.
  const layered = await resolveWorkflowGithubEnvironment(
    deps,
    site.codebaseId,
    prepared.executionUserId,
    prepared.config
  );
  const env = { ...process.env, ...layered.envVars, [RUN_GITHUB_IDENTITY_HANDOFF_ENV]: '1' };
  const context = { cliCommand, env, cwd: site.cwd };
  if ('repo' in target) {
    // The run acts on this repository, so no other remote of the checkout can stand in.
    const failure = await check({ repo: target.repo, operations: needs.operations }, context);
    if (failure !== undefined) refuse([failure], target.repo);
    return target.inputs;
  }
  const failures: ForgeRequirementFailure[] = [];
  for (const { name, url } of target.remotes) {
    const failure = await check({ remote: url, operations: needs.operations }, context);
    // One remote that serves the run is enough: a mirror on a host no plugin claims, or one
    // the credential cannot read, must not refuse a run its canonical remote can serve.
    if (failure === undefined) return undefined;
    failures.push({ remote: name, ...failure });
  }
  refuse(failures);
}

/**
 * What the check judges: the repository the run's inputs name, or else the checkout's
 * remotes, each URL once. A run that cannot name either is refused with the reason.
 */
async function forgeTarget(
  workflow: Pick<ResolvedWorkflow, 'pack' | 'inputs'>,
  names: { host: string; path: string } | undefined,
  site: RunForgeAccessSite
): Promise<
  | { repo: ForgeRepository; inputs: ForgeRepositoryInputs }
  | { remotes: { name: string; url: string }[] }
  | ForgeRequirementFailure
> {
  const inputs =
    names === undefined
      ? undefined
      : (await resolveRunStartInputs(site.settingsCwd, workflow, site.supplied)).inputs;
  const named = namedRepository(names, inputs);
  if (named !== undefined && 'missing' in named) {
    return {
      reason: 'no_forge_repository',
      message: `the run sets input '${named.set}' but not '${named.missing}', which together name its repository`,
      remedy: `Set both ${named.set} and ${named.missing}, or neither to use the checkout's remotes.`,
    };
  }
  if (named !== undefined) return named;
  const remotes = await checkoutRemotes(site.cwd);
  if (remotes === undefined) {
    return {
      reason: 'no_forge_remote',
      message: 'the project is not a git repository',
      remedy: 'Run the workflow in a git checkout whose remote names the forge repository.',
    };
  }
  if (remotes.length === 0) {
    return {
      reason: 'no_forge_remote',
      message: 'the checkout has no git remote',
      remedy: 'Add a remote that names the forge repository, e.g. `git remote add origin <url>`.',
    };
  }
  const seen = new Set<string>();
  const distinct = remotes.filter(({ url }) => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
  return { remotes: distinct };
}

/**
 * The repository the run's inputs name through the pack's `forge.repository`: both inputs
 * set, neither (the checkout's remotes decide), or only one, which names nothing and is
 * refused rather than read as neither.
 */
function namedRepository(
  names: { host: string; path: string } | undefined,
  inputs: Readonly<Record<string, JsonValue>> | undefined
):
  | { repo: ForgeRepository; inputs: ForgeRepositoryInputs }
  | { set: string; missing: string }
  | undefined {
  if (names === undefined) return undefined;
  const raw = (name: string): string => {
    const value = inputs?.[name];
    return typeof value === 'string' ? value : '';
  };
  const host = raw(names.host).trim();
  const path = raw(names.path).trim();
  if (host !== '' && path !== '') {
    return {
      repo: { host, path },
      inputs: { [names.host]: raw(names.host), [names.path]: raw(names.path) },
    };
  }
  if (host === '' && path === '') return undefined;
  return host === ''
    ? { set: names.path, missing: names.host }
    : { set: names.host, missing: names.path };
}

/**
 * The checkout's remotes with the URLs git fetches them from, after any `insteadOf`
 * rewrite, or undefined when it is not a git repository at all.
 */
async function checkoutRemotes(cwd: string): Promise<{ name: string; url: string }[] | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('git', ['-C', cwd, 'remote'], { timeout: 10_000 }));
  } catch (error) {
    if (error instanceof GitFailure && error.kind === 'not_repository') return undefined;
    throw error;
  }
  const names = stdout
    .split(/\r?\n/)
    .map(name => name.trim())
    .filter(name => name.length > 0);
  return Promise.all(
    names.map(async name => {
      const { stdout: url } = await execFileAsync('git', ['-C', cwd, 'remote', 'get-url', name], {
        timeout: 10_000,
      });
      return { name, url: url.trim() };
    })
  );
}

function hostCliCommand(): readonly string[] | undefined {
  let argv: unknown;
  try {
    argv = JSON.parse(process.env.ARCHON_CLI_COMMAND ?? '');
  } catch {
    return undefined;
  }
  return Array.isArray(argv) &&
    argv.length > 0 &&
    argv.every((part): part is string => typeof part === 'string')
    ? argv
    : undefined;
}

/**
 * Ask `archon forge check` about one remote or repository. The request goes through a
 * private file, not argv: a remote URL can carry a credential in its userinfo, and argv is
 * visible to other processes.
 */
const checkThroughCli: ForgeCheck = async (request, { cliCommand, env, cwd }) => {
  const dir = await mkdtemp(join(tmpdir(), 'archon-forge-check-'));
  try {
    const dataFile = join(dir, 'request.json');
    await writeFile(dataFile, JSON.stringify(request), { mode: 0o600 });
    let child: Bun.Subprocess<'ignore', 'pipe', 'ignore'>;
    try {
      // stderr is dropped, never stored or shown: the child holds the remote URL and the
      // run's credential, and its stderr is unplanned output (a crash, a plugin's or git's
      // error) that can echo either. The no-answer refusal names the command to rerun instead.
      child = Bun.spawn([...cliCommand, 'forge', 'check', '--json', '--data-file', dataFile], {
        cwd,
        env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: CHECK_TIMEOUT_MS,
      });
    } catch (error) {
      return {
        reason: 'check_failed',
        message: `archon forge check could not start: ${(error as Error).message}`,
      };
    }
    const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    // `exited` reads 143 for a timeout; the child's own code and signal tell the two apart.
    return forgeCheckFailure(
      stdout,
      { exitCode: child.exitCode, signalCode: child.signalCode },
      request
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** Read one `forge check` answer; exported for its tests. */
export function forgeCheckFailure(
  stdout: string,
  ended: { exitCode: number | null; signalCode: string | null },
  request: ForgeCheckRequest
): Omit<ForgeRequirementFailure, 'remote'> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    raw = undefined;
  }
  const answer = cliForgeResponseSchema.safeParse(raw);
  if (!answer.success) {
    log.warn(ended, 'workflow.forge_check_unanswered');
    return {
      reason: 'check_failed',
      message: unansweredCheck(stdout, ended),
      // A remote stays a placeholder and goes in a file, not argv: its URL can carry a
      // credential, and this remedy is stored.
      remedy:
        'repo' in request
          ? `Write \`${JSON.stringify(request)}\` to a file and run \`archon forge check --json --data-file <file>\` in the project to see what it reports.`
          : `Write \`${JSON.stringify({ remote: '<url>', operations: request.operations })}\` to a private file, with the remote's URL for <url>, and run \`archon forge check --json --data-file <file>\` in the project to see what it reports.`,
    };
  }
  if (answer.data.ok) return undefined;
  const { error, unsupported, remedy } = answer.data;
  const reason = isForgeAccessRefusalKind(error.kind) ? error.kind : 'check_failed';
  return {
    reason,
    message: error.message,
    ...(unsupported ? { unsupported } : {}),
    ...(remedy ? { remedy } : {}),
  };
}

function unansweredCheck(
  stdout: string,
  { exitCode, signalCode }: { exitCode: number | null; signalCode: string | null }
): string {
  if (signalCode !== null)
    return `archon forge check ended on ${signalCode} without an answer; a check still running after ${String(CHECK_TIMEOUT_MS / 1000)}s is stopped with SIGTERM`;
  return stdout.trim() === ''
    ? `archon forge check exited ${String(exitCode)} with no output`
    : `archon forge check exited ${String(exitCode)} without a forge answer on stdout`;
}
