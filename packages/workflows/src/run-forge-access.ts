/**
 * The start-time refusal for a run whose pack declares `forge:` in its `.pack/pack.yaml`.
 *
 * Every fresh start path calls {@link assertRunForgeAccess} beside its credential
 * preflight, before a worktree, a slot or a node: the CLI, chat and Web dispatch, a
 * trigger binding before admission, and a `workflow:` sub-run. Continuations are not
 * checked; a paused run's forge calls still refuse on their own.
 *
 * The check asks `archon forge check` through `ARCHON_CLI_COMMAND`, the same executable,
 * plugin discovery and credential reading the run's own forge calls use, so the check and
 * the run cannot disagree about which plugin serves a remote. No forge operation runs.
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
import type { WorkflowEnvironment } from './deps';
import { resolveWorkflowGithubEnvironment, type WorkflowGithubDeps } from './run-credential-env';
import type { WorkflowPack } from './schemas/pack-settings';

const log = createLogger('workflow.run-forge-access');

const CHECK_TIMEOUT_MS = 30_000;

/**
 * Why a run cannot reach the forge its pack needs. The forge's own refusals pass through;
 * `no_forge_path` and `no_forge_remote` are the run's; `check_failed` is a check that could
 * not answer, which refuses too, because the run's forge calls would fail alike.
 */
export type ForgeRequirementReason =
  | 'no_forge_path'
  | 'no_forge_remote'
  | ForgeAccessRefusalKind
  | 'check_failed';

export interface ForgeRequirementFailure {
  /** The git remote's name, never its URL: a URL can carry a credential. */
  readonly remote?: string;
  readonly reason: ForgeRequirementReason;
  readonly message: string;
  /** The declared capabilities the plugin does not advertise. */
  readonly unsupported?: readonly string[];
  /** The operator's next step, from the plugin or forge, or the engine's own. */
  readonly remedy?: string;
}

export class ForgeRequirementError extends Error {
  constructor(
    workflowName: string,
    packKey: string,
    readonly failures: readonly ForgeRequirementFailure[]
  ) {
    super(
      `Workflow '${workflowName}' cannot start: pack '${packKey}' needs a forge this run cannot reach. ` +
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

/** One `forge check` answer for one remote: `undefined` when the forge can serve the run. */
export type ForgeCheck = (
  request: { remote: string; operations: readonly string[] },
  context: { cliCommand: readonly string[]; env: NodeJS.ProcessEnv; cwd: string }
) => Promise<Omit<ForgeRequirementFailure, 'remote'> | undefined>;

/** Where the run starts: its checkout, and whether it executes in a container. */
export interface RunForgeAccessSite {
  /** The project checkout the run is cut from; a worktree of it has the same remotes. */
  readonly cwd: string;
  readonly codebaseId: string | undefined;
  readonly inContainer?: boolean;
}

/**
 * Refuse a fresh run whose pack declares forge needs this run cannot meet: some remote of
 * the checkout must name a forge whose plugin advertises every declared capability and
 * whose credential resolves. A run whose pack declares nothing returns at once.
 *
 * @throws ForgeRequirementError naming each remote's typed reason and its remedy.
 */
export async function assertRunForgeAccess(
  deps: WorkflowGithubDeps,
  workflow: { readonly name: string; readonly pack?: WorkflowPack },
  /** The run's prepared configuration, before its GitHub credential is layered. */
  prepared: { readonly config: WorkflowEnvironment; readonly executionUserId?: string },
  site: RunForgeAccessSite,
  check: ForgeCheck = checkThroughCli
): Promise<void> {
  const { name: workflowName, pack } = workflow;
  const needs = pack?.forge;
  if (pack === undefined || needs === undefined) return;
  const packKey = pack.key;
  function refuse(failures: ForgeRequirementFailure[]): never {
    throw new ForgeRequirementError(workflowName, packKey, failures);
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
  const remotes = await checkoutRemotes(site.cwd);
  if (remotes === undefined || remotes.length === 0) {
    refuse([
      {
        reason: 'no_forge_remote',
        message:
          remotes === undefined
            ? 'the project is not a git repository'
            : 'the checkout has no git remote',
        remedy:
          remotes === undefined
            ? 'Run the workflow in a git checkout whose remote names the forge repository.'
            : 'Add a remote that names the forge repository, e.g. `git remote add origin <url>`.',
      },
    ]);
  }
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
  // env, and the run's GitHub credential (an App installation token or a per-user token).
  const layered = await resolveWorkflowGithubEnvironment(
    deps,
    site.codebaseId,
    prepared.executionUserId,
    prepared.config
  );
  const env = { ...process.env, ...layered.envVars };
  const failures: ForgeRequirementFailure[] = [];
  const checked = new Set<string>();
  for (const { name, url } of remotes) {
    if (checked.has(url)) continue;
    checked.add(url);
    const failure = await check(
      { remote: url, operations: needs.operations },
      { cliCommand, env, cwd: site.cwd }
    );
    // One remote that serves the run is enough: a mirror on a host no plugin claims must
    // not refuse a run its canonical remote can serve.
    if (failure === undefined) return;
    failures.push({ remote: name, ...failure });
  }
  refuse(failures);
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
 * Ask `archon forge check` for one remote. The request goes through a private file, not
 * argv: a remote URL can carry a credential in its userinfo, and argv is visible to other
 * processes.
 */
const checkThroughCli: ForgeCheck = async (request, { cliCommand, env, cwd }) => {
  const dir = await mkdtemp(join(tmpdir(), 'archon-forge-check-'));
  try {
    const dataFile = join(dir, 'request.json');
    await writeFile(dataFile, JSON.stringify(request), { mode: 0o600 });
    let child: Bun.Subprocess<'ignore', 'pipe', 'ignore'>;
    try {
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
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return forgeCheckFailure(stdout, exitCode);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** Read one `forge check` answer; exported for its tests. */
export function forgeCheckFailure(
  stdout: string,
  exitCode: number | null
): Omit<ForgeRequirementFailure, 'remote'> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    raw = undefined;
  }
  const answer = cliForgeResponseSchema.safeParse(raw);
  if (!answer.success) {
    log.warn({ exitCode }, 'workflow.forge_check_unanswered');
    return {
      reason: 'check_failed',
      message: `archon forge check gave no answer (exit ${String(exitCode)})`,
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
