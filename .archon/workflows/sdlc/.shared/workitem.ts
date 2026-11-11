/**
 * The intake work item: one state document per issue, `work/<number>`, in the run's
 * project scope.
 *
 * The document is the item's state; its labels mirror it, and a label a person adds
 * is a request, never the state. Trust is decided once, by a script, from the
 * project's maintainer list, so no model and no workflow input can raise it. Every
 * event records a request on its item; a run then takes the engine lease of the best
 * waiting item with `archon state claim`, so two runs never work the same item. Every
 * write it makes to the item is refused unless it still holds that lease, and its last
 * write gives the lease back. The engine alone says whether a lease is live: an item
 * whose run can still continue stays held, and one whose run ended is free to claim.
 *
 * The build, merge and split queues claim the same documents the same way, so an item
 * has one owner at a time across the queues; their records are `facts.build`
 * (./build.ts), `facts.merge` (./merge.ts) and `facts.split` (./split.ts).
 */

import { createHash } from 'node:crypto';
import type { BuildRecord } from './build.ts';
import type { Closure } from './close.ts';
import { record, type QualifiedPr } from './forge.ts';
import type { MergeRecord } from './merge.ts';
import type { SplitRecord } from './split.ts';
import { note } from './io.ts';
import {
  type LabelVerdict,
  type PackLabel,
  TRIAGE_REQUEST,
  type Route,
  type Size,
  type WorkType,
  wantedLabels,
} from './labels.ts';
import {
  type Lease,
  stateAppend,
  stateClaim,
  stateDocuments,
  stateGet,
  statePut,
  statePutHeld,
} from './state.ts';
import { OUTPUT_ENUMS } from './outputs.generated.ts';

export type Stage = 'new' | 'needs_maintainer' | Route | 'needs_contract' | 'blocked' | 'close';
/** The trust and path enums archon-intake.yaml's facts node declares; its trust also admits null. */
const INTAKE_ENUMS = OUTPUT_ENUMS['archon-intake'].facts;
export const TRUSTS = INTAKE_ENUMS['decision.trust'].filter(trust => trust !== null);
export type Trust = (typeof TRUSTS)[number];
export const INTAKE_PATHS = INTAKE_ENUMS['decision.path'];
/**
 * What a request records: a forge event, or `retriage`, a pack run's own request to
 * re-triage the item, recorded by that run, whose `run_id` it carries.
 */
export const REQUEST_ACTIONS = ['opened', 'edited', 'reopened', 'added', 'retriage'] as const;
export type RequestAction = (typeof REQUEST_ACTIONS)[number];
/** One request intake has not yet processed. A label request carries who added the label. */
export interface IntakeRequest {
  readonly at: string;
  readonly run_id: string;
  readonly action: RequestAction;
  readonly label: string | null;
  readonly actor: string | null;
  /** The body's digest when a label request was recorded: what a promotion pins. */
  readonly body_digest: string | null;
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
  /** Overlapping issues, earlier attempts and merged changes triage opened; absent on older items. */
  readonly related?: readonly { readonly url: string; readonly relation: string }[];
  readonly at: string;
  readonly run_id: string;
}

export interface HistoryEntry {
  readonly at: string;
  /** The queue whose pickup or decision wrote the entry. */
  readonly stage: 'intake' | 'build' | 'merge' | 'split';
  readonly run_id: string;
  readonly outcome: string;
  readonly summary: string;
  readonly verdict?: string;
  /** Stored as the writing run's artifact pointer; another run's output carries it through `withPlainReports`. */
  readonly report?: { readonly run_id: string; readonly path: string };
}

export interface WorkItem {
  readonly version: 1;
  readonly subject: QualifiedPr;
  readonly created_at: string;
  readonly stage: Stage;
  /** Null until intake first decides it; never changed after that. */
  readonly trust: Trust | null;
  /** Requests waiting for intake. */
  readonly requests: readonly IntakeRequest[];
  /**
   * The requests the intake run holding the item took from `requests`, until its outcome
   * is written. A run that ended before then leaves them here for the next intake pickup.
   */
  readonly taken?: readonly IntakeRequest[];
  /**
   * The branch the build round of `run_id` opens its pull request from, so the next round
   * finds a pull request that run opened and never recorded.
   */
  readonly opening?: { readonly run_id: string; readonly branch: string };
  readonly links: { readonly runs: readonly string[] };
  readonly promoted: Promotion | null;
  readonly facts: {
    readonly intake?: {
      readonly body_digest: string;
      readonly at: string;
      readonly run_id: string;
      /** The request labels the last pickup left waiting for their requests. */
      readonly waiting: readonly string[];
    };
    readonly triage?: TriageFacts;
    readonly build?: BuildRecord;
    readonly merge?: MergeRecord;
    readonly split?: SplitRecord;
  };
  readonly history: readonly HistoryEntry[];
}

/** What the facts node decided for the item it claimed, handed to the outcome node. */
export interface IntakeDecision {
  readonly path: (typeof INTAKE_PATHS)[number];
  readonly trust: Trust | null;
  readonly promoted: Promotion | null;
  readonly stage: Stage;
  readonly body_digest: string;
  /**
   * The issue's labels at pickup that are this run's to remove; the outcome removes
   * only owned labels among them.
   */
  readonly labels: readonly string[];
  /** The request labels on the issue that wait for a request not yet recorded. */
  readonly waiting: readonly string[];
  readonly notes: readonly HistoryEntry[];
}

/** Triage's verdict as the outcome node receives it; its closure and its questions for the author are not stored. */
export interface TriageResult extends Omit<TriageFacts, 'at' | 'run_id'> {
  readonly closure: Closure | null;
  readonly questions: readonly string[];
  readonly labels: readonly string[];
  readonly summary: string;
  readonly report: { readonly run_id: string; readonly path: string };
}

// History, run links and label requests are capped so a label-spamming account cannot
// push the document past the state store's 64 KiB limit and wedge the item. `archon
// state log` keeps every revision.
const KEPT = 50;

const STAGES = {
  new: true,
  needs_maintainer: true,
  investigate: true,
  plan: true,
  deliver: true,
  continue: true,
  split: true,
  needs_contract: true,
  blocked: true,
  close: true,
} as const satisfies Record<Stage, true>;

export function workItemName(number: number): string {
  return `work/${String(number)}`;
}

export function bodyDigest(body: string): string {
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

export function newest<T>(entries: readonly T[]): T[] {
  return entries.slice(-KEPT);
}

/** A label request or a run's re-triage request: what a decision reads. */
function decides(request: { readonly action?: unknown }): boolean {
  return request.action === 'added' || request.action === 'retriage';
}

/**
 * Only label and re-triage requests carry anything a decision reads; any other request
 * just makes the item a candidate, and the pickup reads the live issue. So one of those
 * is kept, however often an author edits.
 */
function queued(requests: readonly IntakeRequest[]): IntakeRequest[] {
  const other = requests.filter(request => !decides(request)).at(-1);
  return newest(requests.filter(request => decides(request) || request === other));
}

export function newWorkItem(subject: QualifiedPr, at: string): WorkItem {
  return {
    version: 1,
    subject,
    created_at: at,
    stage: 'new',
    trust: null,
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
  if (
    doc?.version !== 1 ||
    typeof repo?.host !== 'string' ||
    typeof repo.path !== 'string' ||
    typeof subject?.number !== 'number' ||
    typeof doc.created_at !== 'string' ||
    typeof doc.stage !== 'string' ||
    !Object.hasOwn(STAGES, doc.stage) ||
    !(doc.trust === null || (TRUSTS as readonly unknown[]).includes(doc.trust)) ||
    !Array.isArray(doc.requests) ||
    !(doc.taken === undefined || Array.isArray(doc.taken)) ||
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
 * Rank orders for the ordering keys. Each list is the enum archon-triage-block.yaml's
 * triage node declares for that field, which it lists lowest first.
 */
const TRIAGE_ENUMS = OUTPUT_ENUMS['archon-triage-block'].triage;
export const RANKS = {
  urgency: TRIAGE_ENUMS['urgency.value'],
  importance: TRIAGE_ENUMS['importance.value'],
  size: TRIAGE_ENUMS['size.value'],
  complexity: TRIAGE_ENUMS['complexity.value'],
} as const;
type RankedKey = keyof typeof RANKS;
export interface OrderKey {
  readonly key: RankedKey | 'created';
  readonly direction: 'asc' | 'desc';
}

/**
 * The order every queue claims items in: most urgent, then most important, then
 * smallest, then oldest.
 */
export const PICKUP_ORDER: readonly OrderKey[] = [
  { key: 'urgency', direction: 'desc' },
  { key: 'importance', direction: 'desc' },
  { key: 'size', direction: 'asc' },
  { key: 'created', direction: 'asc' },
];

function sortValue(doc: WorkItem, key: OrderKey['key']): number | string | undefined {
  if (key === 'created') return doc.created_at;
  const value = doc.facts.triage?.[key].value;
  if (value === undefined) return undefined;
  const rank = (RANKS[key] as readonly string[]).indexOf(value);
  return rank === -1 ? undefined : rank;
}

/** Whether the run that last held the item ended without giving its lease back. */
function ownerEnded(lease: Lease | null): boolean {
  return lease !== null && !lease.live;
}

/**
 * Order candidates by the keys, then by issue number. An item whose last owner ended
 * without finishing it sorts after every other, so an item that cannot be read or
 * labelled is retried without starving the rest. An item with no value for a key sorts
 * after every item that has one, whichever the direction, so untriaged items fall back
 * to the later keys.
 */
export function sortCandidates<T extends { readonly doc: WorkItem; readonly lease: Lease | null }>(
  candidates: readonly T[],
  order: readonly OrderKey[]
): T[] {
  return [...candidates].sort((left, right) => {
    const ended = Number(ownerEnded(left.lease)) - Number(ownerEnded(right.lease));
    if (ended !== 0) return ended;
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
  // A re-triage after the split queue's record replaces what that record says here.
  const split = doc.facts.split !== undefined && doc.facts.split.at >= triage.at ? doc.facts.split : undefined;
  // An item the split queue handed back whole carries the route it now waits at.
  const verdict: LabelVerdict =
    split?.status === 'whole' ? { contract: 'READY', route: split.route } : triage.verdict;
  const wanted = wantedLabels(verdict, triage.type.value, triage.size.value);
  // A split PRD stays open, marked as one, until its hypothesis has a verdict.
  if (doc.stage === 'split' && split?.status === 'done' && split.kind === 'prd') wanted.push('archon-prd');
  return wanted;
}

function promotedAt(promoted: Promotion | null, digest: string): boolean {
  return promoted !== null && promoted.pin.body_digest === digest;
}

// --- the decision ---------------------------------------------------------------

export interface IssueFacts {
  /** Undefined when the forge plugin does not report authors. */
  readonly author: string | null | undefined;
  readonly labels: readonly string[];
  readonly state: 'open' | 'closed';
  readonly digest: string;
}

export function isMaintainer(login: string | null, maintainers: ReadonlySet<string>): boolean {
  return login !== null && login !== '' && maintainers.has(login.toLowerCase());
}

/** Whether a pack run asked to re-triage the item; each request is noted by its run. */
function runAsked(requests: readonly IntakeRequest[], noted: (outcome: string, summary: string) => void): boolean {
  const asked = requests.filter(request => request.action === 'retriage');
  for (const request of asked) noted('retriage', `run ${request.run_id} asked for a re-triage`);
  return asked.length > 0;
}

/**
 * Decide what the claimed item needs, from the document, the requests this run took
 * and the live issue. Pure: the outcome node applies the result.
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
  const requests = doc.taken ?? [];
  const claimed = new Set(requests.map(request => request.label));
  const waited = new Set(doc.facts.intake?.waiting ?? []);
  // The request label, when this run claimed no request for it, may have a request on
  // its way, landing at any point of this run or after it, so the label waits for the
  // run that claims it. It waits one pickup: a label still unclaimed after that has no
  // request coming.
  const waits = (label: string): boolean => label === TRIAGE_REQUEST && !claimed.has(label) && !waited.has(label);
  const noted = (outcome: string, summary: string): void => {
    notes.push({ at, stage: 'intake', run_id: runId, outcome, summary });
  };
  const quiet = (stage: Stage = doc.stage): IntakeDecision => ({
    path: 'quiet',
    trust,
    promoted,
    stage,
    body_digest: issue.digest,
    labels: issue.labels.filter(label => !waits(label)),
    waiting: issue.labels.filter(waits),
    notes,
  });
  if (issue.state === 'closed') {
    noted('closed', 'the issue is closed; intake changes nothing on it');
    return { ...quiet(), path: 'closed' };
  }
  if (trust === null) {
    if (issue.author === undefined) {
      throw new Error(
        'the forge plugin does not report issue authors, so trust cannot be decided'
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

  // A run's request re-triages a maintainer's item or a promoted one, and a maintainer's
  // label re-triages or promotes; nothing else starts triage.
  let retriage = runAsked(requests, noted);
  for (const request of requests) {
    const label = request.label;
    if (request.action !== 'added' || label !== TRIAGE_REQUEST) continue;
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
      retriage = true;
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
    retriage = true;
    noted('promoted', `${label} added by ${request.actor} promotes this outside item`);
  }

  const triage = (): IntakeDecision => ({ ...quiet(), path: 'triage' });
  if (trust === 'maintainer') {
    return doc.facts.triage === undefined || retriage ? triage() : quiet();
  }
  // Promotion pins the current body, so an item promoted by this pickup passes here;
  // a run's request on an item no maintainer promoted promotes nothing.
  if (!promotedAt(promoted, issue.digest)) {
    return { ...quiet('needs_maintainer'), path: 'outside' };
  }
  return retriage ? triage() : quiet();
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
  let facts = {
    ...doc.facts,
    intake: { body_digest: decision.body_digest, at, run_id: runId, waiting: decision.waiting },
  };
  if (decision.path === 'triage') {
    if (triage === null) throw new Error('the triage path has no triage verdict');
    // The stored facts are the verdict minus what only this run's outcome reads.
    const { closure: _closure, questions: _questions, labels: _labels, summary, report, ...kept } = triage;
    facts = { ...facts, triage: { ...kept, at, run_id: runId } };
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

// --- pickup ---------------------------------------------------------------------

/**
 * Record a request on the item that sent it, creating the item's document if needed.
 * A request that is not a label adds nothing while another such request waits.
 */
export function enqueue(subject: QualifiedPr, request: IntakeRequest): void {
  const name = workItemName(subject.number);
  const stored = stateGet(name);
  if (stored.value === null) {
    const created = { ...newWorkItem(subject, request.at), requests: [request] };
    if (statePut(name, created, stored.revision) === 'ok') return;
  }
  const waiting = record(stored.value)?.requests;
  if (!decides(request) && Array.isArray(waiting) && waiting.some(entry => !decides(record(entry) ?? {}))) return;
  stateAppend(name, '/requests', request);
}

export interface Read {
  readonly name: string;
  readonly revision: number;
  readonly doc: WorkItem;
  readonly lease: Lease | null;
}

export function read(name: string, stored = stateGet(name)): Read | undefined {
  if (stored.value === null) return undefined;
  try {
    return { name, revision: stored.revision, doc: parseWorkItem(stored.value), lease: stored.lease };
  } catch (error) {
    note(`pickup skips ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * The work item as another run's output carries it. A history report is the writing
 * run's artifact pointer, and the engine refuses an output that points at another
 * run's artifacts, so each report travels as a plain reference: its run id and path.
 */
export function withPlainReports(doc: WorkItem): WorkItem {
  return {
    ...doc,
    history: doc.history.map(({ report, ...entry }) =>
      report === undefined ? entry : { ...entry, report: { run_id: report.run_id, path: report.path } }
    ),
  };
}

/** The item's stored document, or null when it has none. Reads only; claims nothing. */
export function readWorkItem(number: number): WorkItem | null {
  const stored = stateGet(workItemName(number));
  return stored.value === null ? null : parseWorkItem(stored.value);
}

/** Which items a queue's pickup claims. */
export interface Pickup {
  readonly stage: HistoryEntry['stage'];
  /** Whether the item waits for this queue. */
  readonly waits: (doc: WorkItem) => boolean;
}

export const INTAKE_PICKUP: Pickup = {
  stage: 'intake',
  waits: doc => doc.requests.length > 0 || (doc.taken ?? []).length > 0,
};

/**
 * The item with its waiting requests taken by the intake run that holds it. Requests
 * recorded after this wait for the next intake pickup; requests an ended run took and
 * never finished are taken again.
 */
export function withRequestsTaken(doc: WorkItem): WorkItem {
  return { ...doc, taken: queued([...(doc.taken ?? []), ...doc.requests]), requests: [] };
}

// A document can move between the read and the claim: a request is appended at any time.
const ATTEMPTS = 3;

/**
 * Claim the first waiting item in `PICKUP_ORDER`: read every work item in one state
 * call and hand the engine the waiting ones in order, which takes the lease of the
 * first that is unchanged and that no other live run holds. `claimed` names the items
 * this run already took in this pass.
 */
export function claimNext(pickup: Pickup, claimed: ReadonlySet<number> = new Set()): WorkItem | null {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const waiting = stateDocuments('work/')
      .map(stored => read(stored.name, stored))
      .filter((item): item is Read => item !== undefined && !claimed.has(item.doc.subject.number) && pickup.waits(item.doc));
    if (waiting.length === 0) return null;
    const result = stateClaim(
      sortCandidates(waiting, PICKUP_ORDER).map(item => ({ name: item.name, ifRevision: item.revision }))
    );
    if (result.claimed !== null) return parseWorkItem(result.claimed.value);
    if (!result.skipped.some(skip => skip.reason === 'revision_moved')) return null;
  }
  return null;
}

/** Why a named item does not wait for the queue, with the run that holds it when one does. */
function notWaiting(issue: string, item: Read, pickup: Pickup): Error {
  const record = item.doc.facts[pickup.stage];
  const status = record !== undefined && 'status' in record ? `, ${pickup.stage} status ${record.status}` : '';
  const holder = item.lease?.live ? `, held by run ${item.lease.runId}` : '';
  return new Error(`${issue} does not wait for the ${pickup.stage} queue: stage ${item.doc.stage}${status}${holder}`);
}

/** Claim the named item for a queue. Refuses with the facts an operator acts on when it cannot. */
export function claimNamed(number: number, pickup: Pickup): WorkItem {
  const issue = `issue ${String(number)}`;
  const name = workItemName(number);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const item = read(name);
    if (item === undefined) throw new Error(`${issue} has no work item: intake has not recorded it`);
    if (!pickup.waits(item.doc)) throw notWaiting(issue, item, pickup);
    const result = stateClaim([{ name, ifRevision: item.revision }]);
    if (result.claimed !== null) return parseWorkItem(result.claimed.value);
    const holder = result.skipped.find(skip => skip.reason === 'lease_held')?.holder;
    if (holder != null) throw new Error(`${issue} is claimed by run ${holder}`);
  }
  throw new Error(`${issue} kept changing while this run claimed it; launch it again`);
}

/**
 * Replace the document of the item this run holds, re-reading when it moved. The store
 * refuses the write when the lease is no longer this run's. `release` gives the lease
 * back in the same write: nothing is left for this run to do on the item.
 */
export function updateHeld(
  subject: QualifiedPr,
  change: (doc: WorkItem) => WorkItem,
  release = false
): WorkItem {
  const name = workItemName(subject.number);
  // Enqueues append to the document at any time, so a moved revision is ordinary here.
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const stored = stateGet(name);
    const changed = change(parseWorkItem(stored.value));
    const next = { ...changed, requests: queued(changed.requests) };
    const wrote = statePutHeld(name, next, stored.revision, release);
    if (wrote === 'ok') return next;
    if (wrote === 'lease_not_held') throw new Error(`${name} is no longer held by this run`);
  }
  throw new Error(`${name} kept changing: three conditional writes conflicted`);
}
