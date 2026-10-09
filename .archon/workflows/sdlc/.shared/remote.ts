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
  // GitHub's SSH endpoint on port 443 serves the same repositories as github.com.
  if (host === 'ssh.github.com') host = 'github.com';
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  if (host === '' || path === '' || !path.includes('/')) return undefined;
  return { host, path };
}

/** The one remote whose URL names `repo`, undefined when none does; refuses on several. */
export function findRemote(repo: Repo): string | undefined {
  const listed = git('config', '--get-regexp', '^remote\\..*\\.url$');
  // Exit 1 means no remote is configured at all; anything else non-zero is a failure.
  if (listed.code !== 0 && listed.code !== 1) {
    throw new Error(`git config --get-regexp failed: ${listed.stderr}`);
  }
  const names = new Set<string>();
  for (const line of listed.stdout.split('\n')) {
    const space = line.indexOf(' ');
    if (space === -1) continue;
    const named = urlRepo(line.slice(space + 1));
    if (named && sameRepo(named, repo)) names.add(line.slice('remote.'.length, space - '.url'.length));
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
export function remoteFor(repo: Repo): string {
  const remote = findRemote(repo);
  if (remote === undefined) throw new Error(`no git remote points at ${repo.host}/${repo.path}`);
  return remote;
}

/** Fetch `branch` from the remote that holds `repo` and return its remote-tracking ref. */
export function remoteRefFor(repo: Repo, branch: string): string {
  const remote = remoteFor(repo);
  // An explicit refspec: a single-branch clone or a narrowed fetch setting would
  // otherwise update only FETCH_HEAD and leave the tracking ref stale or missing.
  gitOrThrow('fetch', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`);
  return `${remote}/${branch}`;
}

/**
 * Refuse a head that does not merge cleanly into `branch` freshly fetched from the
 * remote that holds `repo` (`git merge-tree`, git 2.38 or later). Every ready mark
 * runs this first: a conflicting pull request is never handed to a maintainer as
 * ready.
 */
export function assertMergesCleanly(repo: Repo, branch: string): void {
  const base = remoteRefFor(repo, branch);
  const result = git('merge-tree', '--write-tree', '--name-only', base, 'HEAD');
  if (result.code === 1) {
    // Output: the tree id, then the conflicted paths, then a blank line and messages.
    const conflicted = result.stdout.split('\n\n')[0].split('\n').slice(1).filter(Boolean);
    throw new Error(`the head does not merge cleanly into ${base}: ${conflicted.join(', ')}`);
  }
  if (result.code !== 0) throw new Error(`mergeability could not be computed: ${result.stderr}`);
}
