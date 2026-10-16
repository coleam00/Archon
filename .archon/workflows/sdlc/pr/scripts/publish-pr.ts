/**
 * Push the branch, then publish the pull request and record its verified identity.
 *
 * The preceding nodes judged the target and the text and proved the merged tree; this
 * node owns the two writes and proves each landed, through whichever source the run
 * selected. The push comes first and refuses on any failure (./.shared/push.ts), so a
 * pull request is never created for a head the remote does not have.
 *
 * Whether this work already has a pull request is decided here, not in a prompt: an
 * open pull request for the recorded head IS the pull request, and a second one is
 * never opened for it. A run continuing a pull request pushes to that pull request's
 * own head as the forge reports it, not to the branch prepare declared, and only
 * while it is open. The push is by merge only — it never forces, so a head that is
 * not an ancestor of this commit refuses.
 *
 * Bound inputs (`with:` bindings, canonical text in env):
 * - INPUTS_REPO / INPUTS_HEAD_REPO: `{host, path}` of the base and head repositories.
 * - INPUTS_HEAD / INPUTS_BASE: the head and base branch names.
 * - INPUTS_BRANCH: the branch a new pull request opens from, as the caller resolved
 *   it; empty uses INPUTS_HEAD.
 * - INPUTS_EXISTING: the pull request this run continues, or `null`.
 * - INPUTS_PULL_REQUEST: the number the caller resolved for it, or empty or `null`.
 * - INPUTS_TITLE: the title.
 * - INPUTS_BODY: the certified body file.
 * - INPUTS_DRAFT: `true` opens a draft.
 */

import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPr, findOpenPrByHead, viewPr } from '../../.shared/pr.ts';
import {
  ForgeOperationError,
  forgeSource,
  type PrRecord,
  type QualifiedPr,
} from '../../.shared/forge.ts';
import { artifactsDir, emit, note, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';
import { pushHead } from '../../.shared/push.ts';

type Repo = QualifiedPr['repo'];

function publish(): PrRecord {
  const source = forgeSource();
  const repo = JSON.parse(text(process.env.INPUTS_REPO)) as Repo;
  const headRepo = JSON.parse(text(process.env.INPUTS_HEAD_REPO)) as Repo;
  const existing = nullableJson(process.env.INPUTS_EXISTING) as number | null;
  const artifacts = artifactsDir();

  const named = nullableJson(process.env.INPUTS_PULL_REQUEST) as number | null;
  if (named !== null && existing !== named) {
    throw new Error(
      `the caller named pull request ${String(named)} to continue, but prepare declared ${String(existing ?? 'none')}`
    );
  }

  if (existing !== null) {
    const view = viewPr({ repo, number: existing }, source);
    const prHeadRepo = view.pr.head_repo;
    if (view.pr.state !== 'open') {
      throw new Error(`pull request ${String(existing)} is ${view.pr.state}; nothing is pushed`);
    }
    if (prHeadRepo === null) {
      throw new Error(`pull request ${String(existing)}'s head repository is gone; nothing is pushed`);
    }
    pushHead({ repo, head_repo: prHeadRepo, head: view.pr.head });
    // The run continues a named pull request: its draft state belongs to its author.
    return viewPr({ repo, number: existing }, source).pr;
  }

  const head = trimmed(process.env.INPUTS_BRANCH) || text(process.env.INPUTS_HEAD);
  const headRevision = pushHead({ repo, head_repo: headRepo, head });

  const open = findOpenPrByHead(repo, headRepo, head, source);
  if (open) {
    note(`publish-pr: ${open.pr.url} already has this head, so no pull request was opened.`);
    return open.pr;
  }

  const bodyPath = text(process.env.INPUTS_BODY);

  // Killing the script cannot cancel a submitted forge write. Keep this claim even
  // after success: a retry may only reconcile it.
  const claimPath = join(artifacts, 'pr-create-started');
  try {
    writeFileSync(claimPath, JSON.stringify({ repo, headRepo, head }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(
        `a previous PR create is unresolved; no open PR was found for ${headRepo.path}:${head}. Reconcile the write recorded at ${claimPath} before creating another PR`
      );
    }
    throw error;
  }
  try {
    return createPr(
      {
        repo,
        headRepo,
        head,
        headRevision,
        base: text(process.env.INPUTS_BASE),
        title: text(process.env.INPUTS_TITLE),
        bodyPath,
        draft: trimmed(process.env.INPUTS_DRAFT) === 'true',
      },
      source
    );
  } catch (error) {
    // A forge refusal is definite: no write was sent, so the claim would only block
    // a retry. Every other failure may have left a pull request behind.
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
