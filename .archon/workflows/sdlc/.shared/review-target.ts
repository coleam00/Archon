import {
  parseQualifiedPr,
  record,
  samePr,
  sameRepo,
  type ForgeSource,
  type PrRecord,
  type QualifiedPr,
} from './forge.ts';
import { git } from './git.ts';
import { note } from './io.ts';
import { findOpenPrByHead, viewPr } from './pr.ts';
import { findRemote, urlRepo } from './remote.ts';

const prUrlKinds = new Map([
  ['pull', 'pull'],
  ['pulls', 'pull'],
  ['merge_requests', 'merge-requests'],
]);

function reviewPrUrl(url: URL): { pr: QualifiedPr; retainedRef: string } {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.at(-1) === 'diffs') parts.pop();
  const number = parts.pop();
  const kind = parts.pop();
  const namespace = prUrlKinds.get(kind ?? '');
  if (kind === 'merge_requests' && parts.at(-1) === '-') parts.pop();
  if (!namespace || !number || !/^[1-9][0-9]*$/.test(number) || parts.length < 2) {
    throw new Error(
      'unsupported PR URL: use a full PR URL ending in its positive number or /diffs'
    );
  }
  return {
    pr: { repo: { host: url.hostname, path: parts.join('/') }, number: Number(number) },
    retainedRef: `refs/${namespace}/${number}/head`,
  };
}

/** The pull request delivery recorded, when the scope is that JSON record. */
export function recordedPr(scope: string): QualifiedPr | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(scope);
  } catch {
    return undefined; // a PR URL, a branch name, or empty
  }
  return record(parsed) ? parseQualifiedPr(scope) : undefined;
}

/** Scope is an explicit PR number, URL, branch, or empty; never a prose selector. */
export function resolveReviewPr(scope: string, source: ForgeSource): PrRecord | undefined {
  const recorded = recordedPr(scope);
  if (recorded) return viewPr(recorded, source).pr;

  const selector = scope.trim();
  let url: URL | undefined;
  try {
    url = new URL(selector);
  } catch {
    // Numbers and branch names are relative to the checkout's repository.
  }
  if (url) {
    const { pr: ref } = reviewPrUrl(url);
    return viewPr(ref, source).pr;
  }

  const listed = git('config', '--get-regexp', '^remote\\..*\\.url$');
  if (listed.code !== 0 && listed.code !== 1)
    throw new Error(`git remote discovery failed: ${listed.stderr}`);
  const repos: QualifiedPr['repo'][] = [];
  for (const line of listed.stdout.split('\n')) {
    const repo = urlRepo(line.slice(line.indexOf(' ') + 1));
    if (repo && !repos.some(other => sameRepo(other, repo))) repos.push(repo);
  }
  if (selector === '') {
    const branch = git('symbolic-ref', '--quiet', '--short', 'HEAD');
    if (branch.code !== 0) {
      if (branch.code === 1) return undefined;
      throw new Error(`git branch discovery failed: ${branch.stderr}`);
    }
    const matches: PrRecord[] = [];
    const unanswered: string[] = [];
    for (const repo of repos) {
      for (const headRepo of repos) {
        let pr: PrRecord | undefined;
        try {
          pr = findOpenPrByHead(repo, headRepo, branch.stdout, source)?.pr;
        } catch (error) {
          // Nothing asked for a PR, so a remote the forge cannot answer for (another
          // host, no auth, offline) leaves the working diff; the note keeps it visible.
          unanswered.push(
            `${repo.host}/${repo.path}: ${error instanceof Error ? error.message : String(error)}`
          );
          continue;
        }
        if (!pr) continue;
        if (
          !sameRepo(pr.repo, repo) ||
          pr.head_repo === null ||
          !sameRepo(pr.head_repo, headRepo) ||
          pr.head !== branch.stdout ||
          pr.state !== 'open'
        ) {
          throw new Error('the forge result does not match the requested head');
        }
        if (!matches.some(other => samePr(other, pr))) matches.push(pr);
      }
    }
    if (matches.length > 1)
      throw new Error(
        'more than one open pull request matches; retry with --input scope=<full-PR-URL>'
      );
    if (unanswered.length > 0) {
      note(
        `Open-PR discovery could not query ${unanswered.join('; ')}. ` +
          'Pass --input scope=<full-PR-URL> to review a PR there.'
      );
    }
    return matches[0];
  }
  if (repos.length !== 1) {
    throw new Error('the review repository is ambiguous; retry with --input scope=<full-PR-URL>');
  }
  const repo = repos[0];
  if (/^[1-9][0-9]*$/.test(selector)) {
    const ref = { repo, number: Number(selector) };
    return viewPr(ref, source).pr;
  }
  const head = selector;
  const pr = findOpenPrByHead(repo, repo, head, source)?.pr;
  if (
    pr &&
    (!sameRepo(pr.repo, repo) ||
      pr.head_repo === null ||
      !sameRepo(pr.head_repo, repo) ||
      pr.head !== head ||
      pr.state !== 'open')
  ) {
    throw new Error('the forge result does not match the requested head');
  }
  if (!pr) throw new Error('no open pull request matches the requested branch');
  return pr;
}

export function retainedReviewRef(pr: PrRecord): string {
  const resolved = reviewPrUrl(new URL(pr.url));
  if (!samePr(resolved.pr, pr)) {
    throw new Error('the forge PR URL does not match its pull-request identity');
  }
  return resolved.retainedRef;
}

/** Resolve absent forge revisions from the base repository's retained PR ref. */
export function reviewHead(pr: PrRecord): string {
  if (pr.head_revision !== null) return pr.head_revision;
  const ref = retainedReviewRef(pr);
  const prerequisite = `Restore access to ${ref} in ${pr.repo.host}/${pr.repo.path}, or restore the forge's head revision, before starting another review.`;
  try {
    const remote = findRemote(pr.repo) ?? `https://${pr.repo.host}/${pr.repo.path}.git`;
    const result = git('ls-remote', '--exit-code', '--refs', '--', remote, ref);
    const rows = result.stdout.split('\n').filter(Boolean);
    const [revision, name] = rows[0]?.split('\t') ?? [];
    if (
      result.code !== 0 ||
      rows.length !== 1 ||
      name !== ref ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision ?? '')
    ) {
      throw new Error(`retained ref lookup exited ${String(result.code)} without one valid head`);
    }
    return revision;
  } catch (error) {
    throw new Error(
      `PR has an unknown head: ${error instanceof Error ? error.message : String(error)}. ${prerequisite}`,
      { cause: error }
    );
  }
}
