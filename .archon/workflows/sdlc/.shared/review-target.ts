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

/** The pull request the scope agent declared, or undefined for a working diff. */
export function declaredPr(value: string): QualifiedPr | undefined {
  const target = value.trim() || 'null';
  const parsed: unknown = JSON.parse(target);
  // Older persisted scope output used `{}` for a working diff.
  if (parsed === null || (typeof parsed === 'object' && Object.keys(parsed).length === 0)) {
    return undefined;
  }
  return parseQualifiedPr(target);
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
    for (const repo of repos) {
      for (const headRepo of repos) {
        const pr = findOpenPrByHead(repo, headRepo, branch.stdout, source)?.pr;
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

/** Refuse a PR whose live base differs from scope's fetched diff base. */
export function checkReviewBase(pr: PrRecord, value: string): void {
  const base = record(JSON.parse(value || 'null'));
  if (
    typeof base?.branch !== 'string' ||
    typeof base.revision !== 'string' ||
    !base.revision.trim()
  ) {
    throw new Error('the PR review has no declared diff base; resolve scope again');
  }
  if (base.branch !== pr.base)
    throw new Error('the PR base changed; resolve scope and review the new diff');
  let revision = pr.base_revision;
  if (revision === null) {
    const remote = findRemote(pr.repo) ?? `https://${pr.repo.host}/${pr.repo.path}.git`;
    const ref = `refs/heads/${pr.base}`;
    const lookup = git('ls-remote', '--exit-code', '--refs', '--', remote, ref);
    const rows = lookup.stdout.split('\n');
    const [sha, name] = rows[0]?.split('\t') ?? [];
    if (
      lookup.code !== 0 ||
      rows.length !== 1 ||
      name !== ref ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha ?? '')
    ) {
      throw new Error(
        `the PR base revision could not be established (lookup exited ${String(lookup.code)})`
      );
    }
    revision = sha;
  }
  if (base.revision !== revision)
    throw new Error('the PR base changed; fetch the base and review the new diff');
}
