/** Pin a review to source objects without moving the checkout shared with other runs. */
import { existsSync, readFileSync, statSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { nodeStartCommit } from '../../.shared/checkout.ts';
import { FULL_REVIEW_RISKS, type ReviewLens } from '../../.shared/review-policy.ts';
import { artifactsDir, emit, nullableJson, refuse, trimmed } from '../../.shared/io.ts';
import { forgeSource, parseQualifiedPr } from '../../.shared/forge.ts';
import { viewPr } from '../../.shared/pr.ts';
import { findRemote, remoteFor } from '../../.shared/remote.ts';
import { gitOrThrow } from '../../.shared/git.ts';
import { recordedReviewPr } from '../../.shared/review-scope.ts';

function revision(): { source: 'revision' | 'checkout'; head: string; base: string } {
  const target = nullableJson(process.env.INPUTS_PR);
  // A composed delivery supplies a recorded PR and reviews its actual build checkout.
  if (target === null || recordedReviewPr(trimmed(process.env.INPUTS_SCOPE))) {
    return { source: 'checkout', head: nodeStartCommit(), base: '' };
  }
  const pr = viewPr(parseQualifiedPr(JSON.stringify(target)), forgeSource()).pr;
  if (pr.head_revision === null || pr.head_repo === null) throw new Error('the PR has no resolvable head');
  const prefix = `refs/archon/review/${randomUUID()}`;
  const baseRef = `${prefix}/base`;
  const headRef = `${prefix}/head`;
  gitOrThrow('fetch', '--no-tags', '--no-write-fetch-head', remoteFor(pr.repo), `+refs/heads/${pr.base}:${baseRef}`);
  const headRemote = findRemote(pr.head_repo) ?? `https://${pr.head_repo.host}/${pr.head_repo.path}.git`;
  gitOrThrow('fetch', '--no-tags', '--no-write-fetch-head', headRemote, `+refs/heads/${pr.head}:${headRef}`);
  const head = gitOrThrow('rev-parse', '--verify', `${headRef}^{commit}`);
  if (head !== pr.head_revision) throw new Error(`PR head changed while fetching: expected ${pr.head_revision}, fetched ${head}; rerun review`);
  return { source: 'revision', head, base: gitOrThrow('rev-parse', '--verify', `${baseRef}^{commit}`) };
}

function recordRevision(facts: ReturnType<typeof revision>, cursor: string): void {
  if (facts.source !== 'revision') return;
  const { head, base } = facts;
  let from = gitOrThrow('merge-base', base, head);
  if (cursor !== '') {
    const merged = Bun.spawnSync(['git', 'merge-tree', '--write-tree', from, cursor]);
    if (merged.exitCode !== 0 && merged.exitCode !== 1) throw new Error(`cannot compute correction delta: ${merged.stderr.toString()}`);
    from = merged.stdout.toString().split('\n')[0];
    gitOrThrow('rev-parse', '--verify', `${from}^{tree}`);
  }
  appendFileSync(join(artifactsDir(), 'review/scope.md'),
    `\n## Pinned source\n\nHead: ${head}\nBase: ${base}\nDiff: git diff ${from} ${head}\n\nRead files with git show ${head}:<path> and search with git grep <pattern> ${head} -- <path>. The shared checkout is not the review source.\n\nChanged files:\n\n${gitOrThrow('diff', '--stat', from, head)}\n`);
}

/**
 * The bound part assignment. The refusal drops the parser's message, which quotes
 * a token of the operator's text.
 */
function partAssignment(value: string | undefined): unknown {
  try {
    return nullableJson(value);
  } catch {
    throw new Error('the part input is not JSON');
  }
}

/** Where publish-review records the commit a published report reviewed. */
const REVIEWED_HEAD = 'reviewed-head';
const NO_LENSES: Record<ReviewLens, boolean> = {
  seams: false,
  code: false,
  tests: false,
  errors: false,
  docs: false,
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function descends(head: string, cursor: string): boolean {
  const result = Bun.spawnSync(['git', 'merge-base', '--is-ancestor', cursor, head]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error(
    `could not compare ${head} with the previous round's reviewed commit ${cursor}: ${result.stderr.toString().trim()}`
  );
}

try {
  const part = partAssignment(process.env.INPUTS_PART);
  const prior = trimmed(process.env.INPUTS_PRIOR_REPORT);
  const facts = revision();
  const { head } = facts;
  // The engine's identity for this node, which synthesis uses to count only this
  // round's lens artifacts.
  const execution: unknown = JSON.parse(process.env.ARCHON_NODE_EXECUTION ?? '');
  if (prior === '') {
    recordRevision(facts, '');
    emit({ ...facts, continuation: false, light: false, cursor: '', risks: FULL_REVIEW_RISKS, execution, ...NO_LENSES, part });
  } else {
    if (!isFile(prior)) throw new Error(`the previous review report does not exist: ${prior}`);
    const recorded = join(dirname(prior), REVIEWED_HEAD);
    if (!existsSync(recorded)) {
      throw new Error(
        `the previous review report records no reviewed commit (${recorded} is missing)`
      );
    }
    const cursor = readFileSync(recorded, 'utf8').trim();
    if (!descends(head, cursor)) {
      throw new Error(
        `the review head is at ${head}, which does not descend from ${cursor}, the commit the previous round reviewed; reviewing it would diff backwards or skip commits`
      );
    }
    const light = trimmed(process.env.INPUTS_LIGHT) === 'true';
    recordRevision(facts, cursor);
    emit({ ...facts, continuation: true, light, cursor, risks: FULL_REVIEW_RISKS, execution, ...NO_LENSES, code: true, part });
  }
} catch (error) {
  refuse(`review-round: ${error instanceof Error ? error.message : String(error)}`);
}
