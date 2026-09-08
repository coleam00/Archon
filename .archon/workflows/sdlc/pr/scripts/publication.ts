import { realpath, readFile, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, join, sep } from 'node:path';

export interface PrIdentity {
  number: number;
  url: string;
  head: string;
  base: string;
  head_sha: string;
  base_sha: string;
  repository: string;
  is_draft: boolean;
}

interface Policy {
  command: string[];
  protected_paths: string[];
}

interface Candidate {
  branch: string;
  head_sha: string;
  repository: string;
  remote_sha: string;
  pr: PrIdentity | null;
  policy: Policy | null;
}

// A repair prepares on a fresh local branch, so the branch that is published to
// is the PR's own head. Deriving it keeps the two identities from drifting.
function publicationHead(candidate: Pick<Candidate, 'branch' | 'pr'>): string {
  return candidate.pr?.head ?? candidate.branch;
}

export interface Preparation {
  title: string;
  body: string;
  base: string;
}

export type Run = (argv: string[]) => Promise<string>;

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object');
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected nonempty text');
  return value;
}

function sha(value: unknown): string {
  const result = string(value);
  if (!/^[a-f0-9]{40}$/.test(result)) throw new Error('Invalid commit identity');
  return result;
}

export function identity(value: unknown): PrIdentity {
  const p = object(value);
  if (!Number.isSafeInteger(p.number) || Number(p.number) <= 0 || typeof p.is_draft !== 'boolean') {
    throw new Error('Invalid PR number or draft state');
  }
  const repository = string(p.repository);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository');
  const url = string(p.url);
  if (url !== `https://github.com/${repository}/pull/${String(p.number)}`) {
    throw new Error('PR URL does not match repository and number');
  }
  return {
    number: Number(p.number), url, repository, head: string(p.head), base: string(p.base),
    head_sha: sha(p.head_sha), base_sha: sha(p.base_sha), is_draft: p.is_draft,
  };
}

export function repositoryFromRemote(remote: string): string {
  const normalized = remote.startsWith('git@github.com:')
    ? `https://github.com/${remote.slice('git@github.com:'.length)}` : remote;
  const url = new URL(normalized);
  if (url.hostname !== 'github.com' || !['https:', 'ssh:'].includes(url.protocol)) {
    throw new Error('Publication supports GitHub origin repositories only');
  }
  const repository = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid GitHub origin');
  return repository;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export async function loadPolicy(path: string, cwd: string): Promise<Policy | null> {
  if (!path) return null;
  if (!isAbsolute(path)) throw new Error('publication_policy must be an absolute operator-owned path');
  const actual = await realpath(path);
  if (inside(await realpath(cwd), actual)) throw new Error('Publication policy must be outside the candidate checkout');
  return parsePolicy(JSON.parse(await readFile(actual, 'utf8')));
}

function parsePolicy(value: unknown): Policy {
  const policy = object(value);
  if (!Array.isArray(policy.command) || !policy.command.length ||
      !policy.command.every(v => typeof v === 'string' && v.length > 0) ||
      !Array.isArray(policy.protected_paths) || !policy.protected_paths.every(v =>
        typeof v === 'string' && v.length > 0 && !v.startsWith('/') &&
        !v.includes('\\') && !v.replace(/\/$/, '').split('/').some(part => ['', '.', '..'].includes(part)) && !v.includes(':'))) {
    throw new Error('Policy requires command argv and repository-relative protected_paths');
  }
  return { command: policy.command, protected_paths: policy.protected_paths };
}

export class Publication {
  constructor(private readonly run: Run, private readonly artifacts: string) {}

  private git(...args: string[]): Promise<string> { return this.run(['git', ...args]); }

  private async repository(): Promise<string> {
    const repository = repositoryFromRemote(await this.git('remote', 'get-url', 'origin'));
    const pushUrls = (await this.git('remote', 'get-url', '--push', '--all', 'origin')).split(/\r?\n/);
    if (pushUrls.length !== 1 || repositoryFromRemote(pushUrls[0]) !== repository) {
      throw new Error('Origin must have one push destination matching its GitHub repository');
    }
    return repository;
  }

  private async clean(): Promise<void> {
    if (await this.git('status', '--porcelain=v1', '--untracked-files=all')) {
      throw new Error('Refusing dirty or uncommitted changes');
    }
  }

  private async remote(head: string): Promise<string> {
    await this.git('check-ref-format', `refs/heads/${head}`);
    const result = await this.git('ls-remote', '--heads', 'origin', `refs/heads/${head}`);
    return result ? sha(result.split(/\s+/)[0]) : '';
  }

  // Repairs must not disturb any branch this clone already has, locally or on
  // origin, so the repair branch is named past every ref that exists now.
  private async freshBranch(pr: PrIdentity): Promise<string> {
    const local = (await this.git('for-each-ref', '--format=%(refname:short)', 'refs/heads/')).split(/\r?\n/);
    const published = (await this.git('ls-remote', '--heads', 'origin')).split(/\r?\n/)
      .map(line => line.split('\t')[1]?.slice('refs/heads/'.length) ?? '');
    const taken = new Set([...local, ...published].filter(Boolean));
    const stem = `archon-repair-${String(pr.number)}-${pr.head_sha.slice(0, 12)}`;
    let branch = stem;
    for (let attempt = 2; taken.has(branch); attempt += 1) branch = `${stem}-${String(attempt)}`;
    return branch;
  }

  async read(repository: string, number: number): Promise<PrIdentity> {
    const raw = object(JSON.parse(await this.run([
      'gh', 'api', `repos/${repository}/pulls/${String(number)}`,
    ])));
    const head = object(raw.head);
    const base = object(raw.base);
    if (raw.state !== 'open' || object(head.repo).full_name !== repository ||
        object(base.repo).full_name !== repository) {
      throw new Error('PR must be open and have its head and base in the origin repository');
    }
    return identity({ number: raw.number, url: raw.html_url, head: head.ref, base: base.ref,
      head_sha: head.sha, base_sha: base.sha, repository, is_draft: raw.draft });
  }

  private async existing(repository: string, head: string): Promise<PrIdentity | null> {
    const result: unknown = JSON.parse(await this.run([
      'gh', 'pr', 'list', '--repo', repository, '--head', head, '--state', 'open', '--json', 'number',
    ]));
    if (!Array.isArray(result) || result.length > 1) throw new Error('Ambiguous existing PR lookup');
    if (!result.length) return null;
    const number = object(result[0]).number;
    if (!Number.isSafeInteger(number)) throw new Error('Invalid existing PR number');
    const pr = await this.read(repository, Number(number));
    if (pr.head !== head) throw new Error('Existing PR lookup returned another head');
    return pr;
  }

  private samePr(actual: PrIdentity, expected: PrIdentity): void {
    for (const key of ['number', 'repository', 'head', 'base', 'head_sha', 'base_sha'] as const) {
      if (actual[key] !== expected[key]) throw new Error(`Stale PR identity: ${key} changed`);
    }
  }

  async snapshot(policy: Policy | null, expected: PrIdentity | null = null): Promise<Candidate> {
    await this.clean();
    const repository = await this.repository();
    const branch = await this.git('branch', '--show-current');
    if (!branch || ['main', 'master'].includes(branch)) throw new Error('Publication requires a feature branch');
    const head_sha = sha(await this.git('rev-parse', 'HEAD'));
    if (expected && repository !== expected.repository) throw new Error('Repository changed');
    // An expected PR is the authority on the published head. Only an ordinary
    // first publication looks a PR up, and then only for its own branch, so a
    // repair branch can never adopt or create someone else's PR.
    const pr = expected ? await this.read(repository, expected.number) : await this.existing(repository, branch);
    if (expected && pr) this.samePr(pr, expected);
    const remote_sha = await this.remote(publicationHead({ branch, pr }));
    if (pr && remote_sha !== pr.head_sha) throw new Error('Remote head does not match PR');
    return { branch, head_sha, repository, remote_sha, pr, policy };
  }

  async checkout(number: number): Promise<PrIdentity> {
    await this.clean();
    const gitDir = await this.git('rev-parse', '--absolute-git-dir');
    const commonDir = await this.git('rev-parse', '--path-format=absolute', '--git-common-dir');
    if (gitDir === commonDir) throw new Error('Cold repair requires an isolated git worktree');
    const repository = await this.repository();
    const pr = await this.read(repository, number);
    if (['main', 'master', pr.base].includes(pr.head)) throw new Error('Refusing protected PR head');
    if (await this.remote(pr.head) !== pr.head_sha) throw new Error('Stale PR head');
    await this.git('fetch', '--no-tags', 'origin', `refs/heads/${pr.head}`);
    if (await this.git('rev-parse', 'FETCH_HEAD') !== pr.head_sha) throw new Error('Head changed during fetch');
    // The PR's own branch usually already exists here: an earlier run in this
    // clone still owns it in another worktree. Repair on a fresh branch instead
    // of taking that one over, and -c still refuses to reuse a name.
    await this.git('switch', '-c', await this.freshBranch(pr), pr.head_sha);
    await this.clean();
    this.samePr(await this.read(repository, number), pr);
    return pr;
  }

  // Reads the expected PR itself rather than looking one up by branch name, so
  // a repair reads back under its own local name and never finds another PR.
  async readback(expected: PrIdentity): Promise<PrIdentity> {
    await this.clean();
    const repository = await this.repository();
    if (repository !== expected.repository) throw new Error('Repository changed');
    const current = await this.read(repository, expected.number);
    this.samePr(current, { ...expected, head_sha: current.head_sha });
    if (await this.remote(current.head) !== current.head_sha) throw new Error('Remote head does not match PR');
    if (await this.git('rev-parse', 'HEAD') !== current.head_sha) throw new Error('Local and published head differ');
    return current;
  }

  private async unchanged(candidate: Candidate): Promise<void> {
    await this.clean();
    if (await this.repository() !== candidate.repository ||
        await this.git('branch', '--show-current') !== candidate.branch ||
        await this.git('rev-parse', 'HEAD') !== candidate.head_sha ||
        await this.remote(publicationHead(candidate)) !== candidate.remote_sha) {
      throw new Error('Candidate or remote identity changed after preparation');
    }
    if (candidate.pr) this.samePr(await this.read(candidate.repository, candidate.pr.number), candidate.pr);
  }

  async publish(candidate: Candidate, preparation: Preparation, draft: boolean): Promise<PrIdentity> {
    const head = publicationHead(candidate);
    const base = candidate.pr?.base ?? string(preparation.base);
    await this.git('check-ref-format', `refs/heads/${base}`);
    if (base === head) throw new Error('PR head equals base');
    const base_sha = await this.remote(base);
    if (!base_sha || (candidate.pr && candidate.pr.base_sha !== base_sha)) throw new Error('Base identity changed');
    await this.git('fetch', '--no-tags', 'origin', `refs/heads/${base}`);
    if (await this.git('rev-parse', 'FETCH_HEAD') !== base_sha) throw new Error('Base changed during fetch');
    if (Number(await this.git('rev-list', '--count', `${base_sha}..${candidate.head_sha}`)) === 0) {
      throw new Error('No committed work ahead of base');
    }
    if (candidate.remote_sha) await this.git('merge-base', '--is-ancestor', candidate.remote_sha, candidate.head_sha);
    await this.unchanged(candidate);
    if (candidate.policy) {
      const paths = (await this.git('diff', '--name-only', '-z', '--no-renames', `${base_sha}...${candidate.head_sha}`)).split('\0').filter(Boolean);
      if (paths.some(path => candidate.policy?.protected_paths.some(protectedPath =>
        path === protectedPath || path.startsWith(`${protectedPath.replace(/\/$/, '')}/`)))) {
        throw new Error('Candidate changes a protected path');
      }
      await this.run(candidate.policy.command);
    }
    await this.unchanged(candidate);
    if (await this.remote(base) !== base_sha) throw new Error('Base changed before publication');
    await this.git('push', 'origin', `${candidate.head_sha}:refs/heads/${head}`);
    if (await this.remote(head) !== candidate.head_sha) throw new Error('Push readback mismatch');
    let pr = candidate.pr ?? await this.existing(candidate.repository, head);
    if (!pr) {
      await this.clean();
      if (await this.git('rev-parse', 'HEAD') !== candidate.head_sha ||
          await this.repository() !== candidate.repository ||
          await this.git('branch', '--show-current') !== candidate.branch ||
          await this.remote(head) !== candidate.head_sha ||
          await this.remote(base) !== base_sha) throw new Error('Identity changed before PR creation');
      const bodyPath = join(this.artifacts, 'pr-body.md');
      await mkdir(this.artifacts, { recursive: true });
      await writeFile(bodyPath, string(preparation.body));
      await this.run(['gh', 'pr', 'create', '--repo', candidate.repository, '--head', head,
        '--base', base, '--title', string(preparation.title), '--body-file', bodyPath,
        ...(draft ? ['--draft'] : [])]);
      pr = await this.existing(candidate.repository, head);
      if (pr) {
        const description = object(JSON.parse(await this.run(['gh', 'pr', 'view', String(pr.number),
          '--repo', candidate.repository, '--json', 'title,body'])));
        if (description.title !== preparation.title || description.body !== preparation.body) {
          throw new Error('Created PR title or body does not match preparation');
        }
      }
    }
    if (!pr) throw new Error('Created PR could not be read back');
    pr = await this.read(candidate.repository, pr.number);
    if (pr.head !== head || pr.base !== base || pr.head_sha !== candidate.head_sha ||
        pr.base_sha !== base_sha || (!candidate.pr && pr.is_draft !== draft)) {
      throw new Error('Published PR identity mismatch');
    }
    if (candidate.pr) {
      // Repairs change the evidence a reviewer needs, including executed test counts.
      // Update only the description after the fixed gate and exact-head readback.
      const descriptionPath = join(this.artifacts, 'pr-description.json');
      await mkdir(this.artifacts, { recursive: true });
      await writeFile(descriptionPath, JSON.stringify({ title: string(preparation.title), body: string(preparation.body) }));
      await this.run(['gh', 'api', `repos/${candidate.repository}/pulls/${String(pr.number)}`,
        '--method', 'PATCH', '--input', descriptionPath]);
      const description = object(JSON.parse(await this.run(['gh', 'pr', 'view', String(pr.number),
        '--repo', candidate.repository, '--json', 'title,body'])));
      if (description.title !== preparation.title || description.body !== preparation.body) {
        throw new Error('Updated PR title or body does not match preparation');
      }
      const after = await this.read(candidate.repository, pr.number);
      this.samePr(after, pr);
      if (after.is_draft !== pr.is_draft) throw new Error('PR draft state changed during description update');
      pr = after;
    }
    return pr;
  }
}

// The resolve stage hands this shape to the finish stage as JSON.
export function parseCandidate(value: unknown): Candidate {
  const p = object(value);
  return { branch: string(p.branch), head_sha: sha(p.head_sha), repository: string(p.repository),
    remote_sha: p.remote_sha === '' ? '' : sha(p.remote_sha),
    pr: p.pr === null ? null : identity(p.pr), policy: p.policy === null ? null : parsePolicy(p.policy) };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<PrIdentity | Candidate | { publish: boolean; candidate: Candidate | PrIdentity }> {
  const run: Run = async argv => {
    const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, , code] = await Promise.all([new Response(child.stdout).text(),
      new Response(child.stderr).text(), child.exited]);
    // Tool output may contain credential-bearing remotes or private gate output.
    if (code !== 0) throw new Error(`${argv[0]} command failed (exit ${String(code)})`);
    return stdout.replace(/\r?\n$/, '');
  };
  const publication = new Publication(run, env.ARTIFACTS_DIR ?? '');
  const operation = env.INPUTS_OPERATION ?? 'publish';
  const expected: unknown = JSON.parse(env.INPUTS_EXPECTED_PR ?? 'null');
  let result: Candidate | PrIdentity;
  if (env.INPUTS_STAGE === 'resolve') {
    if (operation === 'checkout') {
      if (!env.INPUTS_WORK_ORDER?.trim() || !env.INPUTS_FINDINGS?.trim()) throw new Error('Repair requires original work_order and public findings');
      const target = env.INPUTS_TARGET_PR ?? '';
      if (!/^[1-9][0-9]*$/.test(target)) throw new Error('target_pr must be an explicit positive PR number');
      await loadPolicy(env.INPUTS_PUBLICATION_POLICY ?? '', process.cwd());
      result = await publication.checkout(Number(target));
    } else if (operation === 'readback') {
      result = await publication.readback(identity(expected));
    } else if (operation === 'publish') {
      result = await publication.snapshot(await loadPolicy(env.INPUTS_PUBLICATION_POLICY ?? '', process.cwd()),
        expected === null ? null : identity(expected));
    } else throw new Error('Unsupported publication operation');
  } else {
    const artifacts = string(env.ARTIFACTS_DIR);
    const resolved: unknown = JSON.parse(env.INPUTS_RESOLVED ?? 'null');
    if (operation !== 'publish') result = identity(resolved);
    else {
      const prepared = object(JSON.parse(env.INPUTS_PREPARATION ?? 'null'));
      result = await publication.publish(parseCandidate(resolved), {
        title: string(prepared.title), body: string(prepared.body), base: string(prepared.base),
      }, env.INPUTS_DRAFT === 'true');
    }
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, 'pr-identity.json'), JSON.stringify(result, null, 2));
  }
  return env.INPUTS_STAGE === 'resolve' ? { publish: operation === 'publish', candidate: result } : result;
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await main())); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Publication failed'); process.exitCode = 1; }
}
