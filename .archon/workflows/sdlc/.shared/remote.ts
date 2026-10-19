/**
 * Which git remote holds a repository, decided from each remote's URL, never its name.
 *
 * A checkout can be a fork (`origin`) beside the canonical repository (`upstream`), or
 * name its remotes anything at all. Every script that fetches a base or pushes a head
 * is handed the repository identity an agent resolved (`{host, path}`) and finds the
 * remote here, so no script assumes `origin`. URLs are a machine format: HTTPS,
 * `user@host:path` and `ssh://` forms reduce to the same identity, with credentials,
 * ports and a trailing `.git` dropped. The configured URL is read, before any
 * `url.<base>.insteadOf` rewrite: that is the repository the operator named.
 */

import { sameRepo, type QualifiedPr } from './forge.ts';
import { git, gitOrThrow } from './git.ts';

type Repo = QualifiedPr['repo'];

/** The repository a remote URL names, or undefined for a local path or unknown form. */
export function urlRepo(url: string): Repo | undefined {
  const trimmed = url.trim();
  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    host = parsed.hostname;
    path = parsed.pathname;
  } else {
    // scp-like `[user@]host:path`; a Windows drive path (`C:\...`) is not a remote.
    const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(trimmed);
    if (!scp || scp[1].length === 1) return undefined;
    host = scp[1];
    path = scp[2];
  }
  host = host.toLowerCase();
  // GitHub's SSH endpoint on port 443 serves the same repositories as github.com.
  if (host === 'ssh.github.com') host = 'github.com';
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  if (host === '' || path === '' || !path.includes('/')) return undefined;
  return { host, path };
}

/** Every configured remote's name and the repository its URL names, if any. */
function remotes(checkout = process.cwd()): { readonly name: string; readonly repo: Repo | undefined }[] {
  const listed = git('-C', checkout, 'config', '--get-regexp', '^remote\\..*\\.url$');
  // Exit 1 means no remote is configured at all; anything else non-zero is a failure.
  if (listed.code !== 0 && listed.code !== 1) {
    throw new Error(`git config --get-regexp failed: ${listed.stderr}`);
  }
  return listed.stdout.split('\n').flatMap(line => {
    const space = line.indexOf(' ');
    if (space === -1) return [];
    return [
      { name: line.slice('remote.'.length, space - '.url'.length), repo: urlRepo(line.slice(space + 1)) },
    ];
  });
}

/** The distinct repositories this checkout's remotes name. */
export function remoteRepos(): Repo[] {
  const repos: Repo[] = [];
  for (const { repo } of remotes()) {
    if (repo && !repos.some(known => sameRepo(known, repo))) repos.push(repo);
  }
  return repos;
}

/** The one remote whose URL names `repo`, undefined when none does; refuses on several. */
export function findRemote(repo: Repo, checkout = process.cwd()): string | undefined {
  const names = new Set<string>();
  for (const remote of remotes(checkout)) {
    if (remote.repo && sameRepo(remote.repo, repo)) names.add(remote.name);
  }
  if (names.size > 1) {
    throw new Error(
      `several git remotes point at ${repo.host}/${repo.path} (${[...names].join(', ')}); ` +
        'which one is canonical is ambiguous'
    );
  }
  return [...names][0];
}

/** The one remote whose URL names `repo`; refuses on none or several. */
export function remoteFor(repo: Repo, checkout = process.cwd()): string {
  const remote = findRemote(repo, checkout);
  if (remote === undefined) throw new Error(`no git remote points at ${repo.host}/${repo.path}`);
  return remote;
}

export function headDestination(target: {
  readonly repo: Repo;
  readonly head_repo: Repo;
}): string {
  const headRepo = target.head_repo;
  const remote = sameRepo(headRepo, target.repo) ? remoteFor(headRepo) : findRemote(headRepo);
  if (remote === undefined) return `https://${headRepo.host}/${headRepo.path}.git`;
  const urls = gitOrThrow('config', '--get-all', `remote.${remote}.url`).split('\n');
  if (urls.some(url => /^http:\/\//i.test(url.trim()))) {
    throw new Error(`head remote ${remote} requires encrypted transport; use HTTPS or SSH`);
  }
  return remote;
}

/**
 * Fetch the head of the repository's default branch, as its remote reports it, into
 * the remote-tracking ref, whatever branch the checkout sits on.
 */
export function fetchDefaultBranch(repo: Repo): { readonly branch: string; readonly ref: string } {
  const remote = remoteFor(repo);
  const head = gitOrThrow('ls-remote', '--symref', remote, 'HEAD');
  const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(head)?.[1];
  if (branch === undefined) throw new Error(`${remote} reports no default branch`);
  const ref = `refs/remotes/${remote}/${branch}`;
  gitOrThrow('fetch', '--quiet', '--no-tags', remote, `+refs/heads/${branch}:${ref}`);
  return { branch, ref };
}

