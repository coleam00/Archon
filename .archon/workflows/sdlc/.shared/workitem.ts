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
 *
 * The build and merge queues claim the same documents through the same claim, so an
 * item has one owner at a time across the queues; their records are `facts.build`
 * (./build.ts) and `facts.merge` (./merge.ts).
 */

import { createHash } from 'node:crypto';
import type { BuildRecord } from './build.ts';
import type { Closure } from './close.ts';
import { record, type QualifiedPr } from './forge.ts';
import type { MergeRecord } from './merge.ts';
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
import {
  claimDisposition,
  runStatus,
  stateAppend,
  stateDocuments,
  stateGet,
  statePut,
} from './state.ts';

export type Stage = 'new' | 'needs_maintainer' | Route | 'needs_contract' | 'blocked' | 'close';
/** The trust and path vocabularies; a test proves archon-intake.yaml's enums agree. */
export const TRUSTS = ['maintainer', 'outside'] as const;
export type Trust = (typeof TRUSTS)[number];
export const INTAKE_PATHS = ['quiet', 'closed', 'outside', 'triage'] as const;
export const REQUEST_ACTIONS = ['opened', 'edited', 'reopened', 'added'] as const;
export type RequestAction = (typeof REQUEST_ACTIONS)[number];
/** The `trust` input. No value is `maintainer`, so no input can raise trust. */
export const TRUST_INPUTS = ['auto', 'outside'] as const;
export type TrustInput = (typeof TRUST_INPUTS)[number];

function oneOf<const Values extends readonly string[]>(
  name: string,
  values: Values,
  text: string
): Values[number] {
  const value = text.trim() === '' ? values[0] : text.trim();
  if (!values.includes(value)) {
    throw new Error(`${name} must be one of ${values.join(', ')}, not "${value}"`);
  }
  return value as Values[number];
}

/** The `trust` input; empty means `auto`. */
export function parseTrustInput(text: string): TrustInput {
  return oneOf('trust', TRUST_INPUTS, text);
}

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
  /** The queue whose pickup or decision wrote the entry. */
  readonly stage: 'intake' | 'build' | 'merge';
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
      /** The request labels the last pickup left waiting for their requests. */
      readonly waiting: readonly string[];
    };
    readonly triage?: TriageFacts;
    readonly build?: BuildRecord;
    readonly merge?: MergeRecord;
    /** A maintainer's own pull request the merge queue enrolled; no build round made it. */
    readonly own_pr?: { readonly url: string; readonly at: string };
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

/** Triage's verdict as the outcome node receives it. */
export interface TriageResult extends Omit<TriageFacts, 'at' | 'run_id'> {
  /** What made a NO_ACTION item closable; null on every other verdict. Not stored. */
  readonly closure: Closure | null;
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

function isLabelRequest(request: IntakeRequest): boolean {
  return request.action === 'added';
}

/**
 * Only label requests carry anything a decision reads; any other request just makes
 * the item a candidate, and the pickup reads the live issue. So one of those is kept,
 * however often an author edits.
 */
function queued(requests: readonly IntakeRequest[]): IntakeRequest[] {
  const other = requests.filter(request => !isLabelRequest(request)).at(-1);
  return newest(requests.filter(request => isLabelRequest(request) || request === other));
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
    typeof doc.stage !== 'string' ||
    !Object.hasOwn(STAGES, doc.stage) ||
    !(doc.trust === null || (TRUSTS as readonly unknown[]).includes(doc.trust)) ||
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
 * Whether the item's last attempt ended without recording an outcome: a pickup
 * released its claim after the item's latest recorded decision.
 */
export function lastAttemptFailed(doc: WorkItem): boolean {
  const released = doc.history.filter(entry => entry.outcome === 'released').at(-1);
  return released !== undefined && released.at > (doc.facts.intake?.at ?? '');
}

/**
 * Order candidates by the keys, then by issue number. An item whose last attempt
 * failed sorts after every other, so an item that cannot be read or labelled is
 * retried without starving the rest. An item with no value for a key sorts after
 * every item that has one, whichever the direction, so untriaged items fall back to
 * the later keys.
 */
export function sortCandidates<T extends { readonly doc: WorkItem }>(
  candidates: readonly T[],
  order: readonly OrderKey[]
): T[] {
  return [...candidates].sort((left, right) => {
    const failed = Number(lastAttemptFailed(left.doc)) - Number(lastAttemptFailed(right.doc));
    if (failed !== 0) return failed;
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
 *
 * `trustInput: 'outside'` decides an item with no recorded trust as outside without
 * reading its author. It never rewrites recorded trust, so it refuses an item already
 * recorded as a maintainer's. Label actors are still checked against the real list.
 */
export function decideIntake(
  doc: WorkItem,
  issue: IssueFacts,
  maintainers: ReadonlySet<string>,
  at: string,
  runId: string,
  trustInput: TrustInput = 'auto'
): IntakeDecision {
  let trust = doc.trust;
  let promoted = doc.promoted;
  const notes: HistoryEntry[] = [];
  const mirror = new Set<string>(mirrorLabels(doc));
  const claimed = new Set((doc.claim?.requests ?? []).map(request => request.label));
  const waited = new Set(doc.facts.intake?.waiting ?? []);
  // A request label this run neither claimed a request for nor wrote itself may have
  // a request on its way, landing at any point of this run or after it, so the label
  // waits for the run that claims it. It waits one pickup: a label still unclaimed
  // after that has no request coming. On a maintainer's item only archon-triage
  // waits, because any route label's request is reconciled away.
  const waits = (label: string): boolean =>
    isRequestLabel(label) &&
    !mirror.has(label) &&
    !claimed.has(label) &&
    !waited.has(label) &&
    (trust !== 'maintainer' || label === 'archon-triage');
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
  if (trustInput === 'outside' && trust === 'maintainer') {
    throw new Error(
      "trust: outside cannot lower trust this item already recorded as maintainer; a work item's trust is decided once"
    );
  }
  if (trust === null && trustInput === 'outside') {
    trust = 'outside';
  } else if (trust === null) {
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
  let facts = {
    ...doc.facts,
    intake: { body_digest: decision.body_digest, at, run_id: runId, waiting: decision.waiting },
  };
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
  if (
    !isLabelRequest(request) &&
    Array.isArray(waiting) &&
    waiting.some(entry => record(entry)?.action !== 'added')
  )
    return;
  stateAppend(name, '/requests', request);
}

export interface Read {
  readonly name: string;
  readonly revision: number;
  readonly doc: WorkItem;
}

export function read(name: string, stored = stateGet(name)): Read | undefined {
  if (stored.value === null) return undefined;
  try {
    return { name, revision: stored.revision, doc: parseWorkItem(stored.value) };
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

/**
 * Release a claim whose run the engine reports terminal; any other answer holds it.
 * A run that finishes clears its own claim, so a terminal run still holding one
 * stopped before its labels were written, and its requests wait again.
 */
export function releaseIfTerminal(item: Read, at: string, runId: string, pickup: Pickup): Read {
  const claim = item.doc.claim;
  // A pickup that claims several items sees its own claims on its next pass.
  if (claim === null || claim.run_id === runId) return item;
  const status = runStatus(claim.run_id);
  if (claimDisposition(status) === 'hold') {
    if (status === null) {
      note(
        `${pickup.stage} leaves ${item.name} claimed: the engine reports no status for run ${claim.run_id}`
      );
    }
    return item;
  }
  const doc: WorkItem = {
    ...item.doc,
    claim: null,
    requests: queued([...claim.requests, ...item.doc.requests]),
    history: newest([
      ...item.doc.history,
      {
        at,
        stage: pickup.stage,
        run_id: runId,
        outcome: 'released',
        summary: `released the claim of run ${claim.run_id}, which ended ${String(status)} without finishing its outcome; its requests wait again`,
      },
    ]),
  };
  return statePut(item.name, doc, item.revision) === 'ok'
    ? { ...item, revision: item.revision + 1, doc }
    : item;
}

/** Which items a queue's pickup claims, and what its claim takes from the item. */
export interface Pickup {
  readonly stage: HistoryEntry['stage'];
  /** Whether an unclaimed item waits for this queue. */
  readonly waits: (doc: WorkItem) => boolean;
  /**
   * Intake's claim takes the item's waiting requests. Another queue's takes none, so
   * requests recorded while it holds the item still wait for intake.
   */
  readonly takesRequests: boolean;
}

export const INTAKE_PICKUP: Pickup = {
  stage: 'intake',
  waits: doc => doc.requests.length > 0,
  takesRequests: true,
};

function claimed(item: Read, at: string, runId: string, pickup: Pickup): WorkItem {
  if (!pickup.takesRequests) return { ...item.doc, claim: { run_id: runId, at, requests: [] } };
  return {
    ...item.doc,
    claim: { run_id: runId, at, requests: queued(item.doc.requests) },
    requests: [],
  };
}

export function claimable(item: Read | undefined, pickup: Pickup): item is Read {
  return item !== undefined && item.doc.claim === null && pickup.waits(item.doc);
}

/**
 * Read every work item in one state call, release terminal claims, then claim the
 * first waiting item in `order` with a conditional write. A conflict re-reads the
 * item once and claims it only if it still waits unclaimed; otherwise the next
 * candidate is tried.
 */
export function claimNext(
  order: readonly OrderKey[],
  at: string,
  runId: string,
  pickup: Pickup = INTAKE_PICKUP
): WorkItem | null {
  const items = stateDocuments('work/')
    .map(stored => read(stored.name, stored))
    .filter((item): item is Read => item !== undefined)
    .map(item => releaseIfTerminal(item, at, runId, pickup));
  const waiting = items.filter((item): item is Read => claimable(item, pickup));
  for (const candidate of sortCandidates(waiting, order)) {
    const won = claimItem(candidate, at, runId, pickup);
    if (won !== null) return won;
  }
  return null;
}

export function claimItem(
  candidate: Read,
  at: string,
  runId: string,
  pickup: Pickup = INTAKE_PICKUP
): WorkItem | null {
  const doc = claimed(candidate, at, runId, pickup);
  if (statePut(candidate.name, doc, candidate.revision) === 'ok') return doc;
  const fresh = read(candidate.name);
  if (!claimable(fresh, pickup)) return null;
  const retried = claimed(fresh, at, runId, pickup);
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
    const changed = change(doc);
    const next = { ...changed, requests: queued(changed.requests) };
    if (statePut(name, next, stored.revision) === 'ok') return next;
  }
  throw new Error(`${name} kept changing: three conditional writes conflicted`);
}
