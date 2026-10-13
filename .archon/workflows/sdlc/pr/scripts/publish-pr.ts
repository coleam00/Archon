/**
 * Publish the prepared pull request and record its verified identity.
 *
 * The preceding node judges: it establishes the target, writes the body, pushes
 * the branch, and names the pull request the run was launched onto when there is
 * one. This node owns the public write and proves it landed, through whichever
 * source the run selected.
 *
 * Whether this work already has a pull request is decided here, not in a prompt:
 * an open pull request for the recorded head IS the pull request, and a second
 * one is never opened for it.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_INTENT: path to the JSON intent the preparing node wrote.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { contractPath, parseAgentJson } from '../../.shared/agent-json.ts';
import { createPr, findOpenPrByHead, viewPr, type CreatePrIntent } from '../../.shared/pr.ts';
import {
  ForgeOperationError,
  forgeSource,
  record,
  sameRepo,
  type PrRecord,
  type QualifiedPr,
} from '../../.shared/forge.ts';
import { emit, note, refuse, text } from '../../.shared/io.ts';

/** The branch Archon checks a fork pull request out on: `[archon/]pr-<number>-review`. */
const SYNTHETIC_REVIEW_BRANCH = /^(?:archon\/)?pr-\d+-review$/;

function repo(value: unknown, field: string): QualifiedPr['repo'] {
  const parsed = record(value);
  if (
    typeof parsed?.host !== 'string' ||
    parsed.host.trim() === '' ||
    typeof parsed.path !== 'string' ||
    parsed.path.trim() === ''
  ) {
    throw new Error(`the PR intent's ${field} must name a host and an owner/repo path`);
  }
  return { host: parsed.host, path: parsed.path };
}

function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`the PR intent's ${field} must be a non-empty string`);
  }
  return value;
}

function git(...args: string[]): string | undefined {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const out = result.stdout.toString().trim();
  return result.exitCode === 0 && out !== '' ? out : undefined;
}

/** `https://host/owner/repo(.git)` or `git@host:owner/repo(.git)`, without credentials. */
function remoteRepo(): QualifiedPr['repo'] | undefined {
  const url = git('remote', 'get-url', 'origin');
  const match = url && /^(?:[a-z+]+:\/\/(?:[^@/]+@)?|[^@]+@)([^/:]+)[/:](.+?)(?:\.git)?\/?$/i.exec(url);
  return match ? { host: match[1], path: match[2] } : undefined;
}

/**
 * The fields the checkout itself can answer. An agent-written intent that cannot
 * be read, or leaves one of these out, is completed from here instead of failing
 * a delivery whose branch was already pushed: the checkout is the truth the
 * intent was only restating.
 */
function fromCheckout(): Record<string, unknown> {
  const derived: Record<string, unknown> = {};
  const repoFromRemote = remoteRepo();
  if (repoFromRemote) derived.repo = repoFromRemote;
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch && branch !== 'HEAD') derived.head = branch;
  const revision = git('rev-parse', 'HEAD');
  if (revision) derived.headRevision = revision;
  const base = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  if (base) derived.base = base.replace(/^origin\//, '');
  const subject = git('log', '-1', '--format=%s');
  if (subject) derived.title = subject;
  return derived;
}

/** The agent's intent, completed from the checkout where it is unreadable or incomplete. */
function readIntent(intentPath: string): Record<string, unknown> {
  let written: Record<string, unknown> | undefined;
  try {
    written = record(parseAgentJson(readFileSync(intentPath, 'utf8')));
    if (!written) note('publish-pr: the PR intent is not a JSON object; using the checkout.');
  } catch (error) {
    note(
      `publish-pr: could not read the PR intent (${error instanceof Error ? error.message : String(error)}); using the checkout.`
    );
  }
  const intent: Record<string, unknown> = { ...(written ?? {}) };
  const derived = fromCheckout();
  const filled: string[] = [];
  for (const [field, value] of Object.entries(derived)) {
    const current = intent[field];
    const missing =
      current === undefined ||
      current === null ||
      (typeof current === 'string' && current.trim() === '');
    if (missing) {
      intent[field] = value;
      filled.push(field);
    }
  }
  if (intent.bodyPath === undefined || intent.bodyPath === '') {
    intent.bodyPath = join(dirname(intentPath), 'pr-body.md');
    filled.push('bodyPath');
  }
  if (intent.draft === 'true' || intent.draft === 'false') intent.draft = intent.draft === 'true';
  if (intent.draft === undefined) {
    intent.draft = true; // archon-pr's default; a ready flip is a later, explicit step
    filled.push('draft');
  }
  if (typeof intent.existing === 'string' && /^\d+$/.test(intent.existing.trim())) {
    intent.existing = Number(intent.existing.trim());
  }
  if (filled.length > 0) note(`publish-pr: filled ${filled.join(', ')} from the checkout.`);
  return intent;
}

function publish(): PrRecord {
  const source = forgeSource();
  const intentPath = text(process.env.INPUTS_INTENT);
  const intent = readIntent(intentPath);
  const base = repo(intent.repo, 'repo');
  const headRepo = intent.headRepo === undefined ? base : repo(intent.headRepo, 'headRepo');
  const head = required(intent.head, 'head');

  // The run was launched onto an existing pull request: it names the number, and
  // its draft state belongs to its author, not to this run's draft input.
  if (intent.existing !== undefined) {
    if (typeof intent.existing !== 'number' || !Number.isInteger(intent.existing)) {
      throw new Error("the PR intent's existing must be the pull request number");
    }
    const view = viewPr({ repo: base, number: intent.existing }, source);
    const observedHead = view.pr.head_repo;
    if (view.pr.head !== head || observedHead === null || !sameRepo(observedHead, headRepo)) {
      throw new Error(
        `pull request ${String(intent.existing)} has head ${String(view.pr.head_repo?.path)}:${view.pr.head}, not the recorded ${headRepo.path}:${head}`
      );
    }
    return view.pr;
  }

  // A fork pull request's run sits on a synthetic review branch. With no existing
  // pull request named, publishing would push that branch as its own and open a
  // substitute for the pull request it stands in for, so refuse before any write.
  if (SYNTHETIC_REVIEW_BRANCH.test(head)) {
    throw new Error(
      `${head} is a synthetic review branch for another pull request; name that pull request as the intent's existing number instead of opening a new one`
    );
  }

  const existing = findOpenPrByHead(base, headRepo, head, source);
  if (existing) {
    note(`publish-pr: ${existing.pr.url} already has this head, so no pull request was opened.`);
    return existing.pr;
  }
  if (typeof intent.draft !== 'boolean') throw new Error("the PR intent's draft must be a boolean");
  const baseBranch = required(intent.base, 'base');
  const title = required(intent.title, 'title');
  // pr.md fixes the body at $ARTIFACTS_DIR/pr-body.md, beside the intent.
  const contractBody = join(dirname(intentPath), 'pr-body.md');
  let bodyPath = contractPath(required(intent.bodyPath, 'bodyPath'), contractBody);
  if (!existsSync(bodyPath)) {
    // No body was written: describe the branch by its commits rather than fail.
    const log = git('log', `origin/${baseBranch}..HEAD`, '--format=- %s') ?? `- ${title}`;
    bodyPath = contractBody;
    writeFileSync(bodyPath, `## Changes\n\n${log}\n`);
    note('publish-pr: no PR body was written; described the branch by its commits.');
  }
  const createIntent: CreatePrIntent = {
    repo: base,
    headRepo,
    head,
    headRevision: required(intent.headRevision, 'headRevision'),
    base: baseBranch,
    title,
    bodyPath,
    draft: intent.draft,
  };
  readFileSync(createIntent.bodyPath, 'utf8').replace(/^\uFEFF/, '');
  // Killing the script cannot cancel a submitted forge write. Keep this claim
  // beside the durable intent even after success: a retry may only reconcile it.
  const claimPath = `${intentPath}.create-started`;
  try {
    writeFileSync(claimPath, JSON.stringify({ repo: base, headRepo, head }), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(
        `a previous PR create is unresolved; no open PR was found for ${headRepo.path}:${head}. Reconcile the write recorded at ${claimPath} before creating another PR`
      );
    }
    throw error;
  }
  try {
    return createPr(createIntent, source);
  } catch (error) {
    // A forge refusal is definite: no write was sent, so the claim would only
    // block a retry. Every other failure may have left a pull request behind.
    if (error instanceof ForgeOperationError && error.mutation?.outcome === 'refused') {
      unlinkSync(claimPath);
    }
    throw error;
  }
}

try {
  emit(publish());
} catch (error) {
  refuse(`publish-pr: ${error instanceof Error ? error.message : String(error)}`);
}
