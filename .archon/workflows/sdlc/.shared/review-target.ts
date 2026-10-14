import {
  parseQualifiedPr,
  record,
  samePr,
  sameRepo,
  type ForgeSource,
  type PrRecord,
  type QualifiedPr,
} from './forge.ts';
import { git, gitOrThrow } from './git.ts';
import { findOpenPrByHead, viewPr } from './pr.ts';
import { urlRepo } from './remote.ts';

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
    const parts = url.pathname.split('/').filter(Boolean);
    const number = parts.pop();
    const kind = parts.pop();
    if (kind === 'merge_requests' && parts.at(-1) === '-') parts.pop();
    if (
      !['pull', 'pulls', 'merge_requests'].includes(kind ?? '') ||
      !number ||
      !/^[1-9][0-9]*$/.test(number) ||
      parts.length < 2
    ) {
      throw new Error('scope must be a PR URL, positive PR number, branch name, or empty');
    }
    const ref = { repo: { host: url.hostname, path: parts.join('/') }, number: Number(number) };
    const pr = viewPr(ref, source).pr;
    if (!samePr(pr, ref))
      throw new Error('the forge result does not match the requested pull request');
    return pr;
  }

  const listed = git('config', '--get-regexp', '^remote\\..*\\.url$');
  if (listed.code !== 0 && listed.code !== 1)
    throw new Error(`git remote discovery failed: ${listed.stderr}`);
  const repos: QualifiedPr['repo'][] = [];
  for (const line of listed.stdout.split('\n')) {
    const repo = urlRepo(line.slice(line.indexOf(' ') + 1));
    if (repo && !repos.some(other => sameRepo(other, repo))) repos.push(repo);
  }
  if (repos.length !== 1) {
    throw new Error('the review repository is ambiguous; retry with --input scope=<full-PR-URL>');
  }
  const repo = repos[0];
  if (/^[1-9][0-9]*$/.test(selector)) {
    const ref = { repo, number: Number(selector) };
    const pr = viewPr(ref, source).pr;
    if (!samePr(pr, ref))
      throw new Error('the forge result does not match the requested pull request');
    return pr;
  }
  const head = selector || gitOrThrow('symbolic-ref', '--quiet', '--short', 'HEAD');
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
  if (!pr && selector !== '') throw new Error('no open pull request matches the requested branch');
  return pr;
}
