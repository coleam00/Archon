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

import { readFileSync } from 'node:fs';
import { createPr, findOpenPrByHead, viewPr } from '../../.shared/pr.ts';
import {
  forgeSource,
  record,
  sameRepo,
  type PrRecord,
  type QualifiedPr,
} from '../../.shared/forge.ts';
import { emit, note, refuse, text } from '../../.shared/io.ts';

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

function publish(): PrRecord {
  const source = forgeSource(process.env.ARCHON_SDLC_FORGE);
  const intent = record(JSON.parse(readFileSync(text(process.env.INPUTS_INTENT), 'utf8')));
  if (!intent) throw new Error('the PR intent must be a JSON object');
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

  const existing = findOpenPrByHead(base, headRepo, head, source);
  if (existing) {
    note(`publish-pr: ${existing.pr.url} already has this head, so no pull request was opened.`);
    return existing.pr;
  }
  if (typeof intent.draft !== 'boolean') throw new Error("the PR intent's draft must be a boolean");
  return createPr(
    {
      repo: base,
      headRepo,
      head,
      headRevision: required(intent.headRevision, 'headRevision'),
      base: required(intent.base, 'base'),
      title: required(intent.title, 'title'),
      bodyPath: required(intent.bodyPath, 'bodyPath'),
      draft: intent.draft,
    },
    source
  );
}

try {
  emit(publish());
} catch (error) {
  refuse(`publish-pr: ${error instanceof Error ? error.message : String(error)}`);
}
