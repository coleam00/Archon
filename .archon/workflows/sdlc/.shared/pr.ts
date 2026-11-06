/**
 * The pack's pull-request reads and writes, and the marked comment on an issue or
 * pull request, through the forge contract (./forge.ts).
 *
 * Every write is performed and then read back by the forge plugin, which reports
 * which of the contract's four outcomes happened. Nothing here repeats a write.
 * Authored content, such as a pull-request body or a comment, travels in a request
 * file, so it never reaches any process's argv.
 */

import { readFileSync } from 'node:fs';
import { invokeForge, parsePrRecord, qualifiedRepo, record, type PrRecord, type QualifiedPr } from './forge.ts';

export const PR_CREATE_UNRESOLVED = 'pr_create_unresolved';
/** The reason a tail's report gives when a node failure ended the run. */
export const RUN_FAILED = 'failed';

/** Whether a report's reason means the run broke rather than reaching an outcome. */
export function isFailureReason(reason: unknown): boolean {
  return reason === RUN_FAILED || reason === PR_CREATE_UNRESOLVED;
}
export const PR_CREATE_RECORD = 'pr-create-started';

export type PrPublicationRecord =
  | { readonly repo: QualifiedPr['repo']; readonly headRepo: QualifiedPr['repo']; readonly head: string }
  | { readonly pr: PrRecord };

export function encodePrPublicationRecord(value: PrPublicationRecord): string {
  return JSON.stringify(value);
}

export function decodePrPublicationRecord(value: unknown):
  | { readonly state: 'started' }
  | { readonly state: 'verified'; readonly pr: PrRecord } {
  const row = record(value);
  if (row && 'pr' in row) return { state: 'verified', pr: parsePrRecord(row.pr) };
  if (
    !qualifiedRepo(row?.repo) ||
    !qualifiedRepo(row?.headRepo) ||
    typeof row?.head !== 'string' || row.head === ''
  ) throw new Error('invalid PR publication record');
  return { state: 'started' };
}

export interface PrView {
  readonly pr: PrRecord;
  readonly title: string;
  readonly body: string;
}

export interface CreatePrIntent {
  readonly repo: QualifiedPr['repo'];
  readonly headRepo: QualifiedPr['repo'];
  readonly head: string;
  readonly headRevision: string;
  readonly base: string;
  readonly title: string;
  readonly bodyPath: string;
  readonly draft: boolean;
}

/** A forge operation whose success always carries a result. */
function forgeResult(op: string, request: Record<string, unknown>): Record<string, unknown> {
  const value = invokeForge(op, request);
  if (value === null) throw new Error(`forge ${op} returned no result`);
  return value;
}

function forgePrView(value: Record<string, unknown>): PrView {
  return {
    pr: parsePrRecord(record(value)?.pr),
    title: typeof value.title === 'string' ? value.title : '',
    body: typeof value.body === 'string' ? value.body : '',
  };
}

/**
 * The open pull request whose head is `headRepo:head` in `repo`, or undefined. The
 * forge's head selector answers only for an open pull request, and refuses more than one.
 */
export function findOpenPrByHead(
  repo: QualifiedPr['repo'],
  headRepo: QualifiedPr['repo'],
  head: string
): PrView | undefined {
  const value = invokeForge('pr.view', { selector: { kind: 'head', repo, headRepo, head } });
  return value === null ? undefined : forgePrView(value);
}

/**
 * The newest pull request, open, closed or merged, whose head is `head` in `repo`
 * itself, or undefined when the branch never had one. Asking for any state needs the
 * plugin's `pr.view:any-state` capability; without it the host refuses the read,
 * naming the capability.
 */
export function findPrByHead(repo: QualifiedPr['repo'], head: string): PrRecord | undefined {
  const value = invokeForge('pr.view', { selector: { kind: 'head', repo, headRepo: repo, head, state: 'any' } });
  return value === null ? undefined : forgePrView(value).pr;
}

export function viewPr(ref: QualifiedPr): PrView {
  return forgePrView(
    forgeResult('pr.view', { selector: { kind: 'number', ref: { repo: ref.repo, number: ref.number } } })
  );
}

/** Open the pull request and return the record the forge read back. */
export function createPr(intent: CreatePrIntent): PrRecord {
  const value = forgeResult('pr.create', {
    repo: intent.repo,
    headRepo: intent.headRepo,
    head: intent.head,
    headRevision: intent.headRevision,
    base: intent.base,
    title: intent.title,
    body: readFileSync(intent.bodyPath, 'utf8'),
    draft: intent.draft,
  });
  return parsePrRecord(value.pr);
}

/**
 * The markers around the description section a delivery round publishes.
 * `deliver/commands/update-pr-body.md` names them literally; a test holds it to these.
 */
export const DESCRIPTION_SECTION = {
  start: '<!-- archon-delivery-description -->',
  end: '<!-- /archon-delivery-description -->',
} as const;

/**
 * Replace a pull request's whole description and return the record read back from
 * the forge. The contract has no conditional body write, so an edit saved between
 * the caller's read and this write is lost.
 */
export function editPrBody(ref: QualifiedPr, body: string): PrRecord {
  const value = forgeResult('pr.edit-body', { ref: { repo: ref.repo, number: ref.number }, body });
  return parsePrRecord(value.pr);
}

/**
 * Put an open pull request into draft (`draft: true`) or take it out of draft, and
 * return the record read back from the forge. A pull request already in the wanted
 * state is not written.
 */
export function setPrDraft(ref: QualifiedPr, draft: boolean): PrRecord {
  const value = forgeResult(draft ? 'pr.draft' : 'pr.ready', {
    ref: { repo: ref.repo, number: ref.number },
  });
  return parsePrRecord(value.pr);
}

/** An issue or a pull request, as a comment addresses it. */
export interface CommentSubject {
  readonly kind: 'issue' | 'pr';
  readonly ref: QualifiedPr;
}

/**
 * Write the one comment carrying `marker` on its first line, creating it if it is
 * not there yet and replacing it in place when it is. More than one marked comment
 * is a conflict the forge refuses: guessing which one is canonical would silently
 * abandon the other.
 */
export function upsertComment(subject: CommentSubject, marker: string, body: string): { readonly url: string } {
  const ref = { repo: subject.ref.repo, number: subject.ref.number };
  // A pull request keeps the original operation, so a plugin that predates
  // subjects still publishes reviews; an issue needs the subject form.
  const value =
    subject.kind === 'pr'
      ? forgeResult('comment.upsert', { ref, marker, body })
      : forgeResult('workitem.comment.upsert', { subject: { kind: 'issue', ref }, marker, body });
  const comment = record(value.comment);
  if (typeof comment?.url !== 'string') throw new Error('forge returned no verified comment');
  return { url: comment.url };
}
