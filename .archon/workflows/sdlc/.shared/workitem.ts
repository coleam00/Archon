/**
 * The intake work item: one state document per issue, `work/<number>`, in the run's
 * project scope.
 *
 * The document is the item's state; its labels mirror it, and a label a person adds
 * is a request, never the state. Trust is decided once, by a script, from the
 * project's maintainer list, so no model and no workflow input can raise it. Every
 * event records a request on its item; a run then claims the best waiting item with
 * a conditional write, so two runs never work the same item, and releases the claim
 * when it is done. A claim whose run the engine reports terminal is released by the
 * next pickup; any other answer leaves it held, because a live owner and an orphan
 * cannot be told apart here.
 */

import { createHash } from 'node:crypto';
import { archonCommand, record, type QualifiedPr } from './forge.ts';
import { git, gitOrThrow } from './git.ts';
import { note } from './io.ts';
import {
  type LabelVerdict,
  type PackLabel,
  isRequestLabel,
  type Route,
  type Size,
  type WorkType,
  wantedLabels,
} from './labels.ts';
import { remoteFor } from './remote.ts';

export type Stage = 'new' | 'needs_maintainer' | Route | 'needs_contract' | 'blocked' | 'close';
export type Trust = 'maintainer' | 'outside';
export type RequestAction = 'opened' | 'edited' | 'reopened' | 'added';

/** One event intake has not yet processed. A label request carries who added the label. */
export interface IntakeRequest {
  readonly at: string;
  readonly run_id: string;
  readonly action: RequestAction;
  readonly label: string | null;
  readonly actor: string | null;
  /** The body's digest when a label request was recorded: what a promotion pins. */
  readonly body_digest: string | null;
}

export interface Claim {
  readonly run_id: string;
  readonly at: string;
  readonly requests: readonly IntakeRequest[];
}

export interface Promotion {
  readonly at: string;
  readonly via: 'label';
  readonly by: string;
  readonly label: string;
  readonly pin: { readonly body_digest: string };
}

interface Field<Value extends string> {
  readonly value: Value;
  readonly reason: string;
}

export interface TriageFacts {
  readonly verdict: LabelVerdict;
  readonly pull_request: number | null;
  readonly type: Field<WorkType>;
  readonly size: Field<Size>;
  readonly complexity: Field<string>;
  readonly importance: Field<string>;
  readonly urgency: Field<string>;
  readonly at: string;
  readonly run_id: string;
}

export interface HistoryEntry {
  readonly at: string;
  readonly stage: 'intake';
  readonly run_id: string;
  readonly outcome: string;
  readonly summary: string;
  readonly verdict?: string;
  readonly report?: { readonly run_id: string; readonly path: string };
}

export interface WorkItem {
  readonly version: 1;
  readonly subject: QualifiedPr;
  readonly created_at: string;
  readonly stage: Stage;
  /** Null until intake first decides it; never changed after that. */
  readonly trust: Trust | null;
  readonly claim: Claim | null;
  /** Requests waiting for intake. A non-empty list is what makes the item a candidate. */
  readonly requests: readonly IntakeRequest[];
  readonly links: { readonly runs: readonly string[] };
  readonly promoted: Promotion | null;
  readonly facts: {
    readonly intake?: {
      readonly body_digest: string;
      readonly at: string;
      readonly run_id: string;
    };
    readonly triage?: TriageFacts;
  };
  readonly history: readonly HistoryEntry[];
}

/** What the facts node decided for the item it claimed, handed to the outcome node. */
export interface IntakeDecision {
  readonly path: 'quiet' | 'outside' | 'triage';
  readonly trust: Trust | null;
  readonly promoted: Promotion | null;
  readonly stage: Stage;
  readonly body_digest: string;
  readonly notes: readonly HistoryEntry[];
}

/** Triage's verdict as the outcome node receives it. */
export interface TriageResult extends Omit<TriageFacts, 'at' | 'run_id'> {
  readonly labels: readonly string[];
  readonly summary: string;
  readonly report: { readonly run_id: string; readonly path: string };
}

export const MAINTAINERS_PATH = '.archon/sdlc/policy/maintainers.json';
// History and run links are capped so a label-spamming account cannot push the
// document past the state store's 64 KiB limit and wedge the item. `archon state log`
// keeps every revision.
const KEPT = 50;

const STAGES: readonly Stage[] = [
  'new',
  'needs_maintainer',
  'investigate',
  'plan',
  'deliver',
  'continue',
  'needs_contract',
  'blocked',
  'close',
];

export function workItemName(number: number): string {
  return `work/${String(number)}`;
}

export function bodyDigest(body: string): string {
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

function newest<T>(entries: readonly T[]): T[] {
  return entries.slice(-KEPT);
}

export function newWorkItem(subject: QualifiedPr, at: string): WorkItem {
  return {
    version: 1,
    subject,
    created_at: at,
    stage: 'new',
    trust: null,
    claim: null,
    requests: [],
    links: { runs: [] },
    promoted: null,
    facts: {},
    history: [],
  };
}

/** A stored document, checked as far as intake reads it. */
export function parseWorkItem(value: unknown): WorkItem {
  const doc = record(value);
  const subject = record(doc?.subject);
  const repo = record(subject?.repo);
  const claim = doc?.claim === null ? null : record(doc?.claim);
  if (
    doc?.version !== 1 ||
    typeof repo?.host !== 'string' ||
    typeof repo.path !== 'string' ||
    typeof subject?.number !== 'number' ||
    typeof doc.created_at !== 'string' ||
    !STAGES.includes(doc.stage as Stage) ||
    !(doc.trust === null || doc.trust === 'maintainer' || doc.trust === 'outside') ||
    claim === undefined ||
    (claim !== null && (typeof claim.run_id !== 'string' || !Array.isArray(claim.requests))) ||
    !Array.isArray(doc.requests) ||
    !Array.isArray(record(doc.links)?.runs) ||
    !(doc.promoted === null || record(doc.promoted) !== undefined) ||
    record(doc.facts) === undefined ||
    !Array.isArray(doc.history)
  ) {
    throw new Error('not a version 1 intake work item');
  }
  return doc as unknown as WorkItem;
}

// --- ordering -----------------------------------------------------------------

/**
 * Rank orders for the ordering keys. Each list is the triage node's own enum for
 * that field, lowest first; a test proves the two agree.
 */
export const RANKS = {
  urgency: ['none', 'soon', 'now'],
  importance: ['low', 'medium', 'high'],
  size: ['s', 'm', 'l'],
  complexity: ['low', 'medium', 'high'],
} as const;
type RankedKey = keyof typeof RANKS;
export interface OrderKey {
  readonly key: RankedKey | 'created';
  readonly direction: 'asc' | 'desc';
}

export const DEFAULT_ORDER = '["urgency desc","importance desc","size asc","created asc"]';

/** The `order` input: a JSON array of `"<key> <asc|desc>"`. Anything else refuses. */
export function parseOrder(text: string): OrderKey[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim() === '' ? DEFAULT_ORDER : text);
  } catch {
    throw new Error('order is not a JSON array');
  }
  if (!Array.isArray(parsed)) throw new Error('order is not a JSON array');
  return parsed.map(entry => {
    const [key, direction, ...rest] = typeof entry === 'string' ? entry.split(' ') : [];
    if (
      rest.length > 0 ||
      !(key === 'created' || Object.hasOwn(RANKS, key ?? '')) ||
      (direction !== 'asc' && direction !== 'desc')
    ) {
      throw new Error(
        `order entry ${JSON.stringify(entry)} is not "<urgency|importance|size|complexity|created> <asc|desc>"`
      );
    }
    return { key: key as OrderKey['key'], direction };
  });
}

function sortValue(doc: WorkItem, key: OrderKey['key']): number | string | undefined {
  if (key === 'created') return doc.created_at;
  const value = doc.facts.triage?.[key].value;
  if (value === undefined) return undefined;
  const rank = (RANKS[key] as readonly string[]).indexOf(value);
  return rank === -1 ? undefined : rank;
}

/**
 * Order candidates by the keys, then by issue number. An item with no value for a
 * key sorts after every item that has one, whichever the direction, so untriaged
 * items fall back to the later keys.
 */
export function sortCandidates<T extends { readonly doc: WorkItem }>(
  candidates: readonly T[],
  order: readonly OrderKey[]
): T[] {
  return [...candidates].sort((left, right) => {
    for (const { key, direction } of order) {
      const a = sortValue(left.doc, key);
      const b = sortValue(right.doc, key);
      if (a === b) continue;
      if (a === undefined) return 1;
      if (b === undefined) return -1;
      const ascending = a < b ? -1 : 1;
      return direction === 'asc' ? ascending : -ascending;
    }
    return left.doc.subject.number - right.doc.subject.number;
  });
}

/** Whether a pickup may release a claim, from the claiming run's status. */
export function claimDisposition(status: string | null): 'hold' | 'release' {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
    ? 'release'
    : 'hold';
}

// --- labels -------------------------------------------------------------------

export function stageFromVerdict(verdict: LabelVerdict): Stage {
  switch (verdict.contract) {
    case 'READY':
      return verdict.route;
    case 'NEEDS_CONTRACT_WORK':
      return 'needs_contract';
    case 'BLOCKED':
      return 'blocked';
    case 'NO_ACTION':
      return 'close';
  }
}

/** The pack labels the document says the issue carries. */
export function mirrorLabels(doc: WorkItem): PackLabel[] {
  if (doc.stage === 'needs_maintainer') return ['archon-needs-maintainer'];
  const triage = doc.facts.triage;
  if (doc.stage === 'new' || triage === undefined) return [];
  return wantedLabels(triage.verdict, triage.type.value, triage.size.value);
}

function promotedAt(promoted: Promotion | null, digest: string): boolean {
  return promoted !== null && promoted.pin.body_digest === digest;
}

/**
 * The install's own forge identity must never promote an outside item, so the
 * outcome node refuses to add a request label to one that is not promoted at the
 * body it just recorded.
 */
export function assertNoSelfPromotion(doc: WorkItem, add: readonly string[]): void {
  const digest = doc.facts.intake?.body_digest ?? '';
  if (doc.trust === 'outside' && !promotedAt(doc.promoted, digest)) {
    const promoting = add.filter(isRequestLabel);
    if (promoting.length > 0) {
      throw new Error(
        `refusing to add ${promoting.join(', ')} to an outside item no maintainer promoted`
      );
    }
  }
}

// --- the decision ---------------------------------------------------------------

export interface IssueFacts {
  /** Undefined when the selected source does not report authors. */
  readonly author: string | null | undefined;
  readonly labels: readonly string[];
  readonly state: 'open' | 'closed';
  readonly digest: string;
}

export function isMaintainer(login: string | null, maintainers: ReadonlySet<string>): boolean {
  return login !== null && login !== '' && maintainers.has(login.toLowerCase());
}

/**
 * Decide what the claimed item needs, from the document, its claimed requests and
 * the live issue. Pure: the outcome node applies the result.
 */
export function decideIntake(
  doc: WorkItem,
  issue: IssueFacts,
  maintainers: ReadonlySet<string>,
  at: string,
  runId: string
): IntakeDecision {
  let trust = doc.trust;
  let promoted = doc.promoted;
  const notes: HistoryEntry[] = [];
  const noted = (outcome: string, summary: string): void => {
    notes.push({ at, stage: 'intake', run_id: runId, outcome, summary });
  };
  const quiet = (stage: Stage = doc.stage): IntakeDecision => ({
    path: 'quiet',
    trust,
    promoted,
    stage,
    body_digest: issue.digest,
    notes,
  });
  if (issue.state === 'closed') {
    noted('closed', 'the issue is closed; intake changes nothing on it');
    return quiet();
  }
  if (trust === null) {
    if (issue.author === undefined) {
      throw new Error(
        'the selected forge source does not report issue authors, so trust cannot be decided'
      );
    }
    trust = isMaintainer(issue.author, maintainers) ? 'maintainer' : 'outside';
  }

  if (promoted !== null && !promotedAt(promoted, issue.digest)) {
    noted(
      'demoted',
      `the body changed after promotion (pinned ${promoted.pin.body_digest}, now ${issue.digest})`
    );
    promoted = null;
  }

  const mirror = new Set<string>(mirrorLabels(doc));
  let retriage = false;
  let promotedNow = false;
  for (const request of doc.claim?.requests ?? []) {
    const label = request.label;
    if (request.action !== 'added' || label === null || !isRequestLabel(label)) continue;
    // The pack writes the work item before any label, so a label already in the
    // document's mirror is the pack's own write coming back as an event.
    if (mirror.has(label)) continue;
    if (!issue.labels.includes(label)) {
      noted('void', `${label} was removed before intake read it`);
      continue;
    }
    if (!isMaintainer(request.actor, maintainers)) {
      noted(
        'refused',
        `${label} added by ${request.actor || 'an unknown account'}, who is not a listed maintainer; it promotes nothing`
      );
      continue;
    }
    if (trust === 'maintainer') {
      if (label === 'archon-triage') retriage = true;
      else
        noted(
          'reconciled',
          `${label} added by ${request.actor} disagrees with the work item and is removed; add archon-triage to re-triage`
        );
      continue;
    }
    if (request.body_digest !== issue.digest) {
      noted(
        'refused',
        `${label} added by ${request.actor}, but the body changed after the request; add the label again`
      );
      continue;
    }
    promoted = {
      at,
      via: 'label',
      by: request.actor as string,
      label,
      pin: { body_digest: issue.digest },
    };
    promotedNow = true;
    noted('promoted', `${label} added by ${request.actor} promotes this outside item`);
  }

  const triage = (): IntakeDecision => ({ ...quiet(), path: 'triage' });
  if (trust === 'maintainer') {
    return doc.facts.triage === undefined || retriage ? triage() : quiet();
  }
  if (promotedNow) return triage();
  if (!promotedAt(promoted, issue.digest)) {
    return { ...quiet('needs_maintainer'), path: 'outside' };
  }
  return quiet();
}

/**
 * The document after the outcome node applies a decision. Built on the fresh read,
 * so requests appended while this run worked stay queued.
 */
export function applyDecision(
  doc: WorkItem,
  decision: IntakeDecision,
  triage: TriageResult | null,
  /** The body changed while a promoted outside item was being triaged. */
  bodyMoved: boolean,
  at: string,
  runId: string
): WorkItem {
  const history: HistoryEntry[] = [...doc.history, ...decision.notes];
  let stage = decision.stage;
  let promoted = decision.promoted;
  let facts = { ...doc.facts, intake: { body_digest: decision.body_digest, at, run_id: runId } };
  if (decision.path === 'triage') {
    if (triage === null) throw new Error('the triage path has no triage verdict');
    const { verdict, pull_request, type, size, complexity, importance, urgency, summary, report } =
      triage;
    facts = {
      ...facts,
      triage: {
        verdict,
        pull_request,
        type,
        size,
        complexity,
        importance,
        urgency,
        at,
        run_id: runId,
      },
    };
    if (bodyMoved) {
      stage = 'needs_maintainer';
      promoted = null;
      history.push({
        at,
        stage: 'intake',
        run_id: runId,
        outcome: 'demoted',
        summary: 'the body changed during triage; the promotion no longer holds',
        report,
      });
    } else {
      stage = stageFromVerdict(triage.verdict);
      history.push({
        at,
        stage: 'intake',
        run_id: runId,
        outcome: stage,
        verdict: triage.verdict.contract,
        summary,
        report,
      });
    }
  } else if (decision.path === 'outside' && doc.stage !== 'needs_maintainer') {
    history.push({
      at,
      stage: 'intake',
      run_id: runId,
      outcome: 'needs_maintainer',
      summary: 'the author is not a listed maintainer; waiting for a maintainer to promote it',
    });
  }
  return {
    ...doc,
    stage,
    trust: decision.trust,
    promoted,
    facts,
    history: newest(history),
    links: { runs: newest([...doc.links.runs.filter(id => id !== runId), runId]) },
  };
}

// --- the maintainer list ------------------------------------------------------------

/** The maintainer list's text, lower-cased logins; anything but an array of logins refuses. */
export function parseMaintainers(text: string): Set<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${MAINTAINERS_PATH} is not valid JSON`);
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every(login => typeof login === 'string' && login.trim() !== '')
  ) {
    throw new Error(`${MAINTAINERS_PATH} must be a JSON array of forge logins`);
  }
  return new Set(parsed.map(login => (login as string).trim().toLowerCase()));
}

/**
 * The maintainer list at the head of the repository's default branch, read with git
 * so it works on either forge source and whatever branch the checkout sits on. No
 * file means nobody: every author is outside.
 */
export function readMaintainers(repo: QualifiedPr['repo']): Set<string> {
  const remote = remoteFor(repo);
  const head = gitOrThrow('ls-remote', '--symref', remote, 'HEAD');
  const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(head)?.[1];
  if (branch === undefined) throw new Error(`${remote} reports no default branch`);
  const ref = `refs/remotes/${remote}/${branch}`;
  gitOrThrow('fetch', '--quiet', '--no-tags', remote, `+refs/heads/${branch}:${ref}`);
  if (git('cat-file', '-e', `${ref}:${MAINTAINERS_PATH}`).code !== 0) return new Set();
  return parseMaintainers(gitOrThrow('show', `${ref}:${MAINTAINERS_PATH}`));
}

// --- the state store ------------------------------------------------------------

const STATE_CONFLICT = 3;

function archon(args: readonly string[], input?: string): { code: number; value: unknown } {
  const result = Bun.spawnSync([...archonCommand(), ...args], {
    stdin: input === undefined ? 'ignore' : Buffer.from(input),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let value: unknown;
  try {
    value = JSON.parse(result.stdout.toString());
  } catch {
    value = undefined;
  }
  return { code: result.exitCode, value };
}

function failed(what: string, result: { code: number; value: unknown }): Error {
  const message = record(result.value)?.error;
  return new Error(
    `archon ${what} failed (exit ${String(result.code)})${typeof message === 'string' ? `: ${message}` : ''}`
  );
}

export interface Stored {
  readonly revision: number;
  readonly value: unknown;
}

export function stateGet(name: string): Stored {
  const result = archon(['state', 'get', name]);
  const value = record(result.value);
  if (result.code !== 0 || typeof value?.revision !== 'number')
    throw failed(`state get ${name}`, result);
  return { revision: value.revision, value: value.value ?? null };
}

/** A conditional replace: `conflict` when the document moved past `ifRevision`. */
export function statePut(name: string, value: unknown, ifRevision: number): 'ok' | 'conflict' {
  const result = archon(
    ['state', 'put', name, '--if-revision', String(ifRevision)],
    JSON.stringify(value)
  );
  if (result.code === STATE_CONFLICT) return 'conflict';
  if (result.code !== 0) throw failed(`state put ${name}`, result);
  return 'ok';
}

/** Append to an array in the latest revision; appends never conflict. */
export function stateAppend(name: string, path: string, value: unknown): void {
  const result = archon(
    ['state', 'patch', name],
    JSON.stringify({ ops: [{ op: 'append', path, value }] })
  );
  if (result.code !== 0) throw failed(`state patch ${name}`, result);
}

export function stateList(prefix: string): string[] {
  const result = archon(['state', 'list', '--prefix', prefix]);
  const documents = record(result.value)?.documents;
  if (result.code !== 0 || !Array.isArray(documents)) throw failed('state list', result);
  return documents
    .map(record)
    .filter(row => row?.deleted === false && typeof row.name === 'string')
    .map(row => row?.name as string);
}

/** The run's status as the engine reports it, or null when it gives no status. */
export function runStatus(runId: string): string | null {
  const status = record(archon(['workflow', 'get', runId, '--json']).value)?.status;
  return typeof status === 'string' ? status : null;
}

// --- pickup ---------------------------------------------------------------------

/** Record a request on the item that sent it, creating the item's document if needed. */
export function enqueue(subject: QualifiedPr, request: IntakeRequest): void {
  const name = workItemName(subject.number);
  const stored = stateGet(name);
  if (stored.value === null) {
    const created = { ...newWorkItem(subject, request.at), requests: [request] };
    if (statePut(name, created, stored.revision) === 'ok') return;
  }
  stateAppend(name, '/requests', request);
}

export interface Read {
  readonly name: string;
  readonly revision: number;
  readonly doc: WorkItem;
}

function read(name: string): Read | undefined {
  const stored = stateGet(name);
  if (stored.value === null) return undefined;
  try {
    return { name, revision: stored.revision, doc: parseWorkItem(stored.value) };
  } catch (error) {
    note(`intake skips ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** Release a claim whose run the engine reports terminal; any other answer holds it. */
function releaseIfTerminal(item: Read, at: string, runId: string): Read {
  const claim = item.doc.claim;
  if (claim === null) return item;
  const status = runStatus(claim.run_id);
  if (claimDisposition(status) === 'hold') {
    if (status === null) {
      note(
        `intake leaves ${item.name} claimed: the engine reports no status for run ${claim.run_id}`
      );
    }
    return item;
  }
  // A run that recorded its outcome honored its requests; any other gets them back.
  const honored = item.doc.facts.intake?.run_id === claim.run_id;
  const doc: WorkItem = {
    ...item.doc,
    claim: null,
    requests: honored ? item.doc.requests : [...claim.requests, ...item.doc.requests],
    history: newest([
      ...item.doc.history,
      {
        at,
        stage: 'intake',
        run_id: runId,
        outcome: 'released',
        summary: `released the claim of run ${claim.run_id}, which ended ${String(status)}${honored ? '' : '; its requests wait again'}`,
      },
    ]),
  };
  return statePut(item.name, doc, item.revision) === 'ok'
    ? { ...item, revision: item.revision + 1, doc }
    : item;
}

function claimed(item: Read, at: string, runId: string): WorkItem {
  return { ...item.doc, claim: { run_id: runId, at, requests: item.doc.requests }, requests: [] };
}

function claimable(item: Read | undefined): item is Read {
  return item !== undefined && item.doc.claim === null && item.doc.requests.length > 0;
}

/**
 * Release terminal claims, then claim the first waiting item in `order` with a
 * conditional write. A conflict re-reads the item once and claims it only if it
 * still waits unclaimed; otherwise the next candidate is tried.
 */
export function claimNext(order: readonly OrderKey[], at: string, runId: string): WorkItem | null {
  const items = stateList('work/')
    .map(read)
    .filter((item): item is Read => item !== undefined)
    .map(item => releaseIfTerminal(item, at, runId));
  for (const candidate of sortCandidates(items.filter(claimable), order)) {
    const won = claimItem(candidate, at, runId);
    if (won !== null) return won;
  }
  return null;
}

export function claimItem(candidate: Read, at: string, runId: string): WorkItem | null {
  const doc = claimed(candidate, at, runId);
  if (statePut(candidate.name, doc, candidate.revision) === 'ok') return doc;
  const fresh = read(candidate.name);
  if (!claimable(fresh)) return null;
  const retried = claimed(fresh, at, runId);
  return statePut(fresh.name, retried, fresh.revision) === 'ok' ? retried : null;
}

/**
 * Replace the document of the item this run holds, re-reading on a conflict. Refuses
 * when the claim is no longer this run's, for example after a failed run's claim was
 * released and the run was then resumed.
 */
export function updateClaimed(
  subject: QualifiedPr,
  runId: string,
  change: (doc: WorkItem) => WorkItem
): WorkItem {
  const name = workItemName(subject.number);
  // Enqueues append to the document at any time, so a conflict is ordinary here.
  for (let attempt = 0; attempt < 3; attempt++) {
    const stored = stateGet(name);
    const doc = parseWorkItem(stored.value);
    if (doc.claim?.run_id !== runId) throw new Error(`${name} is no longer claimed by this run`);
    const next = change(doc);
    if (statePut(name, next, stored.revision) === 'ok') return next;
  }
  throw new Error(`${name} kept changing: three conditional writes conflicted`);
}
