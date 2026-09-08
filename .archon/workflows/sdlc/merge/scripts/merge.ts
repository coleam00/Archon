import { lstat, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

export interface AcceptanceReceipt {
  schema_version: 1;
  repository: { owner: string; name: string };
  pr: number;
  head_sha: string;
  base_sha: string;
  verdict: 'approve';
}

export type Acceptance = Omit<AcceptanceReceipt, 'repository'> & { repository: string };

export interface Policy {
  authorized: boolean;
  repository: string;
  base_branch: string;
  required_checks: string[];
  hold_labels: string[];
  accept_races: boolean;
  stop_file?: string;
}

export interface MergeResult {
  status: 'merged' | 'held' | 'revalidation_required' | 'failed';
  repository: string;
  pr: number;
  head_sha: string;
  base_sha: string;
  summary: string;
  merge_commit: string;
}

export interface PullRequest {
  repository: string;
  pr: number;
  head_sha: string;
  base_branch: string;
  head_repository: string;
  state: string;
  draft: boolean;
  merged: boolean;
  merge_commit: string;
  mergeable: boolean | null;
  auto_merge: boolean;
  labels: string[];
}

export interface Candidate {
  pull: PullRequest;
  base_sha: string;
  contains_base: boolean;
  merge_queue: boolean;
  checks: { name: string; passed: boolean }[];
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a JSON object');
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error('Expected a nonempty string');
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Expected a boolean');
  return value;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected an array');
  return value;
}

function strings(value: unknown): string[] {
  return array(value).map(string);
}

function paginatedRows(value: unknown, field: string): unknown[] {
  const pages = array(value).map(object);
  const total = pages[0]?.total_count;
  if (
    typeof total !== 'number' ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    pages.some(page => page.total_count !== total)
  ) {
    throw new Error('Incomplete or changing GitHub check response');
  }
  const rows = pages.flatMap(page => array(page[field]));
  if (rows.length !== total) throw new Error('Incomplete GitHub check pagination');
  return rows;
}

function sha(value: unknown): string {
  const result = string(value);
  if (!/^[0-9a-f]{40}$/.test(result)) throw new Error('Expected a full lowercase Git SHA');
  return result;
}

function repository(value: unknown): string {
  const result = string(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(result)) {
    throw new Error('Expected repository owner/name');
  }
  return result.toLowerCase();
}

function prNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Expected a positive PR number');
  }
  return value;
}

export function parseAcceptance(value: unknown): Acceptance {
  const data = object(value);
  if (data.schema_version !== 1 || data.verdict !== 'approve') {
    throw new Error('Acceptance must have schema_version 1 and verdict approve');
  }
  const repo = object(data.repository);
  const owner = string(repo.owner);
  const name = string(repo.name);
  if (owner.includes('/') || name.includes('/')) throw new Error('Invalid receipt repository');
  return {
    schema_version: 1,
    repository: repository(`${owner}/${name}`),
    pr: prNumber(data.pr),
    head_sha: sha(data.head_sha),
    base_sha: sha(data.base_sha),
    verdict: 'approve',
  };
}

export function parsePolicy(value: unknown): Policy {
  const data = object(value);
  const allowed = [
    'authorized',
    'repository',
    'base_branch',
    'required_checks',
    'hold_labels',
    'stop_file',
    'accept_races',
  ];
  if (Object.keys(data).some(key => !allowed.includes(key)))
    throw new Error('Unknown policy field');
  const stop = data.stop_file === undefined ? undefined : string(data.stop_file);
  if (stop !== undefined && !isAbsolute(stop)) throw new Error('stop_file must be absolute');
  return {
    authorized: data.authorized === undefined ? false : boolean(data.authorized),
    repository: repository(data.repository),
    base_branch: string(data.base_branch),
    required_checks: strings(data.required_checks),
    hold_labels: strings(data.hold_labels),
    accept_races: data.accept_races === undefined ? false : boolean(data.accept_races),
    ...(stop === undefined ? {} : { stop_file: stop }),
  };
}

export function parseTarget(value: string, expectedRepository: string): number {
  if (/^[1-9][0-9]*$/.test(value)) return prNumber(Number(value));
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)\/?$/.exec(value);
  if (!match || repository(match[1]) !== expectedRepository) {
    throw new Error('Target must be a GitHub PR URL in the policy repository or a positive number');
  }
  return prNumber(Number(match[2]));
}

function result(
  acceptance: Acceptance,
  status: MergeResult['status'],
  summary: string,
  mergeCommit = ''
): MergeResult {
  return {
    status,
    repository: acceptance.repository,
    pr: acceptance.pr,
    head_sha: acceptance.head_sha,
    base_sha: acceptance.base_sha,
    summary,
    merge_commit: mergeCommit,
  };
}

function identityMatches(acceptance: Acceptance, policy: Policy, pull: PullRequest): boolean {
  return (
    pull.repository === acceptance.repository &&
    pull.pr === acceptance.pr &&
    policy.repository === acceptance.repository &&
    pull.base_branch === policy.base_branch &&
    pull.head_repository === acceptance.repository
  );
}

export function decide(
  acceptance: Acceptance,
  policy: Policy,
  candidate: Candidate,
  stopped: boolean
): MergeResult | null {
  const { pull } = candidate;
  if (!identityMatches(acceptance, policy, pull))
    return result(acceptance, 'held', 'Repository, PR, base branch, or head repository mismatch');
  if (pull.head_sha !== acceptance.head_sha || candidate.base_sha !== acceptance.base_sha) {
    return result(
      acceptance,
      'revalidation_required',
      'PR head or base branch moved since acceptance'
    );
  }
  if (!policy.authorized) return result(acceptance, 'held', 'Operator has not authorized merge');
  if (!policy.accept_races)
    return result(
      acceptance,
      'held',
      'Operator must explicitly accept the documented base and check races'
    );
  if (stopped) return result(acceptance, 'held', 'Operator stop file exists');
  if (pull.labels.some(label => policy.hold_labels.includes(label)))
    return result(acceptance, 'held', 'PR has an operator hold label');
  if (pull.merged || pull.state !== 'open' || pull.draft)
    return result(acceptance, 'held', 'PR is not open and ready');
  if (candidate.merge_queue || pull.auto_merge)
    return result(acceptance, 'held', 'Merge queues and existing auto-merge are unsupported');
  if (pull.mergeable !== true)
    return result(acceptance, 'held', 'Mergeability is conflicting or unknown');
  if (!candidate.contains_base)
    return result(
      acceptance,
      'revalidation_required',
      'PR head does not contain the accepted base'
    );
  if (
    candidate.checks.some(check => !check.passed) ||
    policy.required_checks.some(
      name => !candidate.checks.some(check => check.name === name && check.passed)
    )
  ) {
    return result(acceptance, 'held', 'A check is missing, pending, failed, or unknown');
  }
  return null;
}

export interface MergeIO {
  readPolicy(): Promise<Policy>;
  readAcceptance(): Promise<Acceptance>;
  stopped(policy: Policy): Promise<boolean>;
  authenticate(): Promise<void>;
  readPull(repository: string, pr: number): Promise<PullRequest>;
  inspect(pull: PullRequest): Promise<Candidate>;
  merge(acceptance: Acceptance): Promise<number>;
  mergeParents(repository: string, commit: string): Promise<string[]>;
  write(result: MergeResult): Promise<void>;
}

async function mergedResult(
  acceptance: Acceptance,
  policy: Policy,
  pull: PullRequest,
  io: MergeIO
): Promise<MergeResult> {
  if (
    !identityMatches(acceptance, policy, pull) ||
    pull.head_sha !== acceptance.head_sha ||
    !pull.merge_commit
  ) {
    return result(
      acceptance,
      'failed',
      'Remote PR is merged but does not match the accepted identity',
      pull.merge_commit
    );
  }
  let parents: string[];
  try {
    parents = await io.mergeParents(acceptance.repository, pull.merge_commit);
  } catch {
    return result(
      acceptance,
      'failed',
      'Remote PR reports merged, but merge parent verification failed; reconcile manually',
      pull.merge_commit
    );
  }
  if (
    parents.length !== 2 ||
    parents[0] !== acceptance.base_sha ||
    parents[1] !== acceptance.head_sha
  ) {
    return result(
      acceptance,
      'revalidation_required',
      'Remote PR is merged but merge parents differ from the accepted base and head; reconcile manually',
      pull.merge_commit
    );
  }
  return result(
    acceptance,
    'merged',
    'Remote merge verified against the accepted base and head',
    pull.merge_commit
  );
}

async function mergeAndReadBack(
  acceptance: Acceptance,
  policy: Policy,
  io: MergeIO
): Promise<MergeResult> {
  let exit: number | undefined;
  try {
    exit = await io.merge(acceptance);
  } catch {
    // Readback owns the remote outcome, including transport failures.
  }
  try {
    const after = await io.readPull(acceptance.repository, acceptance.pr);
    return after.merged
      ? await mergedResult(acceptance, policy, after, io)
      : result(
          acceptance,
          'failed',
          `Merge not confirmed (command exit ${exit ?? 'unavailable'}); inspect remote state before retrying`
        );
  } catch {
    return result(
      acceptance,
      'failed',
      'Merge was attempted but readback failed; remote outcome is unknown. Inspect GitHub before retrying'
    );
  }
}

async function evaluateMerge(
  acceptance: Acceptance,
  policy: Policy,
  io: MergeIO
): Promise<MergeResult> {
  await io.authenticate();
  const pull = await io.readPull(acceptance.repository, acceptance.pr);
  if (pull.merged) return mergedResult(acceptance, policy, pull, io);
  const initial = decide(acceptance, policy, await io.inspect(pull), await io.stopped(policy));
  if (initial) return initial;

  const current = await io.readPull(acceptance.repository, acceptance.pr);
  if (current.merged) return mergedResult(acceptance, policy, current, io);
  const candidate = await io.inspect(current);
  // The final authorization read follows every remote preflight request.
  const currentPolicy = await io.readPolicy();
  const refusal = decide(acceptance, currentPolicy, candidate, await io.stopped(currentPolicy));
  return refusal ?? (await mergeAndReadBack(acceptance, currentPolicy, io));
}

export async function governMerge(target: string, io: MergeIO): Promise<MergeResult> {
  let outcome: MergeResult = {
    status: 'failed',
    repository: '',
    pr: 0,
    head_sha: '',
    base_sha: '',
    summary: '',
    merge_commit: '',
  };
  try {
    const policy = await io.readPolicy();
    const acceptance = await io.readAcceptance();
    outcome = result(acceptance, 'failed', 'Merge did not complete');
    if (
      parseTarget(target, policy.repository) !== acceptance.pr ||
      policy.repository !== acceptance.repository
    ) {
      throw new Error('Target, policy, and receipt identity must agree');
    }
    outcome = await evaluateMerge(acceptance, policy, io);
  } catch (error) {
    outcome = {
      ...outcome,
      status: 'failed',
      summary: `Merge refused: ${error instanceof Error ? error.message : 'unexpected failure'}`,
    };
  }
  try {
    await io.write(outcome);
  } catch {
    outcome = {
      ...outcome,
      summary: `${outcome.summary}. Local merge.json write failed; preserve this returned result`,
    };
  }
  return outcome;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
}
export type RunCommand = (args: string[]) => Promise<CommandResult>;

export const runCommand: RunCommand = async args => {
  const child = Bun.spawn(args, {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GH_HOST: 'github.com',
      GH_PROMPT_DISABLED: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout };
};

export function github(
  run: RunCommand
): Pick<MergeIO, 'authenticate' | 'readPull' | 'inspect' | 'merge' | 'mergeParents'> {
  async function api(endpoint: string, paginate = false, fields: string[] = []): Promise<unknown> {
    const response = await run([
      'gh',
      'api',
      '--hostname',
      'github.com',
      ...(paginate ? ['--paginate', '--slurp'] : []),
      endpoint,
      ...fields,
    ]);
    if (response.exitCode !== 0)
      throw new Error(`GitHub API read failed (exit ${response.exitCode})`);
    try {
      return JSON.parse(response.stdout);
    } catch {
      throw new Error('GitHub API returned invalid JSON');
    }
  }
  return {
    async authenticate() {
      const user = object(await api('user'));
      string(user.login);
      if (typeof user.id !== 'number' || user.id <= 0)
        throw new Error('Authenticated GitHub operator is required');
    },
    async readPull(repo, pr) {
      const data = object(await api(`repos/${repo}/pulls/${pr}`));
      const head = object(data.head);
      const base = object(data.base);
      return {
        repository: repository(object(base.repo).full_name),
        pr: prNumber(data.number),
        head_repository: head.repo === null ? '' : repository(object(head.repo).full_name),
        head_sha: sha(head.sha),
        base_branch: string(base.ref),
        state: string(data.state),
        draft: boolean(data.draft),
        merged: boolean(data.merged),
        merge_commit: data.merged === true ? sha(data.merge_commit_sha) : '',
        mergeable: data.mergeable === null ? null : boolean(data.mergeable),
        auto_merge: data.auto_merge !== null,
        labels: array(data.labels).map(label => string(object(label).name)),
      };
    },
    async inspect(pull) {
      const prefix = `repos/${pull.repository}`;
      const [owner, name] = pull.repository.split('/');
      const response = object(
        await api('graphql', false, [
          '-f',
          'query=query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){isMergeQueueEnabled}}}',
          '-f',
          `owner=${owner}`,
          '-f',
          `name=${name}`,
          '-F',
          `pr=${pull.pr}`,
        ])
      );
      if (response.errors !== undefined) throw new Error('GitHub merge queue query failed');
      const queue = object(object(object(response.data).repository).pullRequest);
      const base = object(
        await api(`${prefix}/git/ref/heads/${encodeURIComponent(pull.base_branch)}`)
      );
      const baseSha = sha(object(base.object).sha);
      const comparison = object(await api(`${prefix}/compare/${baseSha}...${pull.head_sha}`));
      const runPages = array(
        await api(`${prefix}/commits/${pull.head_sha}/check-runs?filter=latest&per_page=100`, true)
      );
      const statusPages = array(
        await api(`${prefix}/commits/${pull.head_sha}/status?per_page=100`, true)
      );
      const checks = paginatedRows(runPages, 'check_runs').map(value => {
        const check = object(value);
        return {
          name: string(check.name),
          passed:
            check.head_sha === pull.head_sha &&
            check.status === 'completed' &&
            check.conclusion === 'success',
        };
      });
      for (const page of statusPages) {
        const data = object(page);
        if (sha(data.sha) !== pull.head_sha) throw new Error('Commit status SHA mismatch');
      }
      for (const value of paginatedRows(statusPages, 'statuses')) {
        const status = object(value);
        checks.push({ name: string(status.context), passed: status.state === 'success' });
      }
      return {
        pull,
        base_sha: baseSha,
        contains_base: sha(object(comparison.merge_base_commit).sha) === baseSha,
        checks,
        merge_queue: boolean(queue.isMergeQueueEnabled),
      };
    },
    async merge(acceptance) {
      return (
        await run([
          'gh',
          'pr',
          'merge',
          String(acceptance.pr),
          '--repo',
          `https://github.com/${acceptance.repository}`,
          '--merge',
          '--match-head-commit',
          acceptance.head_sha,
        ])
      ).exitCode;
    },
    async mergeParents(repo, commit) {
      return array(object(await api(`repos/${repo}/git/commits/${commit}`)).parents).map(parent =>
        sha(object(parent).sha)
      );
    },
  };
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export async function externalPath(path: string, cwd: string, missing = false): Promise<string> {
  if (!isAbsolute(path))
    throw new Error('Operator paths must be absolute and external to the checkout');
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch (error) {
    if (!missing || !(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
      throw new Error('Cannot resolve operator path');
    resolved = join(await realpath(dirname(path)), basename(path));
  }
  if (inside(await realpath(cwd), resolved))
    throw new Error('Operator path is inside the candidate checkout');
  for (let parent = dirname(resolved); ; parent = dirname(parent)) {
    let gitEntry = false;
    try {
      await lstat(join(parent, '.git'));
      gitEntry = true;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
        throw new Error('Cannot inspect operator path ancestry');
    }
    if (gitEntry) throw new Error('Operator path must be outside Git worktrees');
    if (parent === dirname(parent)) break;
  }
  return resolved;
}

export function localIO(
  env: NodeJS.ProcessEnv,
  cwd: string,
  run: RunCommand = runCommand
): MergeIO {
  async function readExternal(path: string | undefined): Promise<unknown> {
    const resolved = await externalPath(path ?? '', cwd);
    if (!(await lstat(resolved)).isFile()) throw new Error('Operator input must be a regular file');
    try {
      return JSON.parse(await readFile(resolved, 'utf8'));
    } catch {
      throw new Error('Cannot read operator JSON file');
    }
  }
  return {
    ...github(run),
    async readPolicy() {
      return parsePolicy(await readExternal(env.INPUTS_POLICY));
    },
    async readAcceptance() {
      return parseAcceptance(await readExternal(env.INPUTS_RECEIPT));
    },
    async stopped(policy) {
      if (!policy.stop_file) return false;
      // Only the external policy selects this path. Presence can veto authority,
      // never grant it, so an operator checkout may hold the STOP entry.
      // Resolve the parent, not the entry: even a dangling symlink must stop.
      const path = join(await realpath(dirname(policy.stop_file)), basename(policy.stop_file));
      try {
        await lstat(path);
        return true;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
        throw new Error('Cannot inspect operator stop file');
      }
    },
    async write(value) {
      const dir = env.ARTIFACTS_DIR;
      if (!dir || !isAbsolute(dir)) throw new Error('ARTIFACTS_DIR must be absolute');
      const destination = join(dir, 'merge.json');
      const temporary = join(dir, `merge-${process.pid}.tmp`);
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
      await rename(temporary, destination);
    },
  };
}

if (import.meta.main) {
  console.log(
    JSON.stringify(
      await governMerge(process.env.INPUTS_TARGET ?? '', localIO(process.env, process.cwd()))
    )
  );
}
