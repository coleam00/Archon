/**
 * The discoveries workflow's state: one decision record per decided discovery, and
 * one claim document per drained run.
 *
 * `discoveries/decisions/<key>` holds what was decided about one discovery, under a
 * short key the deciding agent chose, with every run record (`<run-id>:<ref>`) that
 * found it. It is the workflow's memory and its commit point: a record is decided
 * once a decision record that is not `asked` lists it. The agent reads every record
 * before deciding, so a discovery already handled is not handled again, and a
 * maintainer's answer applies to later items. One small document per key keeps every
 * write well under the store's document cap.
 *
 * `discoveries/runs/<run-id>` is a drained run's work item: only the claim of the
 * pass working it.
 */

import type { QualifiedPr } from './forge.ts';
import type { DiscoveryRecord } from './report.ts';
import { isObject } from './typed.ts';

export const DECISIONS_PREFIX = 'discoveries/decisions/';
export const RUNS_PREFIX = 'discoveries/runs/';
const KEY = /^[a-z0-9][a-z0-9-]{2,80}$/;

export type IssueRef = QualifiedPr;

/**
 * What became of a discovery. A decision record is written before its public write,
 * and holds what that write still owes: a `filed` decision keeps the issue's body and
 * has a null issue until the create reads back, and a `tracked` decision keeps its
 * evidence comment until the comment is posted. The next live pass finishes either by
 * its marker, so a pass that stopped between the two never files or comments twice.
 */
export type Decision =
  | { readonly kind: 'filed'; readonly issue: IssueRef | null; readonly body: string }
  | {
      readonly kind: 'tracked';
      readonly issue: IssueRef;
      /** Evidence still to post; null once it is posted, or when there is none. */
      readonly comment: string | null;
    }
  | { readonly kind: 'dropped' }
  | { readonly kind: 'asked' };

/** Whether the decision still owes a public write. */
export function unfinished(decision: Decision): boolean {
  return (
    (decision.kind === 'filed' && decision.issue === null) ||
    (decision.kind === 'tracked' && decision.comment !== null)
  );
}

export interface Question {
  readonly text: string;
  readonly recommendation: string;
  readonly answer: { readonly text: string; readonly at: string } | null;
}

export interface DecisionRecord {
  readonly version: 1;
  readonly key: string;
  readonly title: string;
  readonly decision: Decision;
  readonly reason: string;
  /** The base commit the claim was checked against. */
  readonly verified_at: string;
  readonly at: string;
  /** Every run record that found this discovery, as `<run-id>:<ref>`. */
  readonly refs: readonly string[];
  /** The last question asked about it, with its answer once there is one. */
  readonly question: Question | null;
}

export interface RunClaim {
  readonly version: 1;
  readonly claim: { readonly run_id: string; readonly at: string } | null;
}

export function isKey(value: unknown): value is string {
  return typeof value === 'string' && KEY.test(value);
}

export function decisionName(key: string): string {
  if (!isKey(key)) throw new Error(`"${key}" is not a decision key (${KEY.source})`);
  return `${DECISIONS_PREFIX}${key}`;
}

export function runName(runId: string): string {
  return `${RUNS_PREFIX}${runId}`;
}

function isQualifiedRef(ref: unknown): ref is string {
  return typeof ref === 'string' && ref.indexOf(':') > 0;
}

/** The run a qualified ref belongs to. */
export function refRun(ref: string): string {
  if (!isQualifiedRef(ref)) throw new Error(`"${ref}" is not a qualified discovery ref`);
  return ref.slice(0, ref.indexOf(':'));
}

/** The refs some decision already settled: every ref a record that is not `asked` lists. */
export function decidedRefs(records: readonly DecisionRecord[]): Set<string> {
  return new Set(records.filter(record => record.decision.kind !== 'asked').flatMap(record => record.refs));
}

function text(value: unknown): value is string {
  return typeof value === 'string';
}

function issueRef(value: unknown): IssueRef | undefined {
  if (!isObject(value) || !isObject(value.repo)) return undefined;
  const { host, path } = value.repo;
  return text(host) &&
    host !== '' &&
    text(path) &&
    path !== '' &&
    typeof value.number === 'number' &&
    Number.isInteger(value.number) &&
    value.number > 0
    ? { repo: { host, path }, number: value.number }
    : undefined;
}

function decision(value: unknown): Decision | undefined {
  if (!isObject(value)) return undefined;
  switch (value.kind) {
    case 'filed': {
      const issue = value.issue === null ? null : issueRef(value.issue);
      if (issue === undefined || !text(value.body)) return undefined;
      return { kind: 'filed', issue, body: value.body };
    }
    case 'tracked': {
      const issue = issueRef(value.issue);
      if (issue === undefined || !(value.comment === null || text(value.comment))) return undefined;
      return { kind: 'tracked', issue, comment: value.comment };
    }
    case 'dropped':
    case 'asked':
      return { kind: value.kind };
    default:
      return undefined;
  }
}

function question(value: unknown): Question | null | undefined {
  if (value === null) return null;
  if (!isObject(value) || !text(value.text) || !text(value.recommendation)) return undefined;
  const answer = value.answer;
  if (answer === null) return { text: value.text, recommendation: value.recommendation, answer };
  if (!isObject(answer) || !text(answer.text) || !text(answer.at)) return undefined;
  return {
    text: value.text,
    recommendation: value.recommendation,
    answer: { text: answer.text, at: answer.at },
  };
}

/**
 * A stored decision record. Anything else refuses, naming the document: a record
 * that does not parse must never read as "not decided yet", which would file it again.
 */
export function parseDecisionRecord(name: string, value: unknown): DecisionRecord {
  const fail = (why: string): never => {
    throw new Error(`${name} is not a decision record: ${why}`);
  };
  if (!isObject(value) || value.version !== 1) return fail('no version 1 object');
  if (!isKey(value.key) || name !== `${DECISIONS_PREFIX}${value.key}`) {
    return fail('its key does not match its name');
  }
  const parsed = decision(value.decision);
  if (parsed === undefined) return fail('its decision is malformed');
  const asked = question(value.question);
  if (asked === undefined) return fail('its question is malformed');
  if (
    !text(value.title) ||
    !text(value.reason) ||
    !text(value.verified_at) ||
    !text(value.at) ||
    !Array.isArray(value.refs)
  ) {
    return fail('a title, reason, verified_at, at or refs field is missing');
  }
  if (!value.refs.every(isQualifiedRef)) return fail('a ref is not of the form <run-id>:<ref>');
  return {
    version: 1,
    key: value.key,
    title: value.title,
    decision: parsed,
    reason: value.reason,
    verified_at: value.verified_at,
    at: value.at,
    refs: value.refs,
    question: asked,
  };
}

/** A drained run's claim document; null when there is none yet. */
export function parseRunClaim(name: string, value: unknown): RunClaim | null {
  if (value === null) return null;
  const claim = isObject(value) ? value.claim : undefined;
  if (
    !isObject(value) ||
    value.version !== 1 ||
    !(claim === null || (isObject(claim) && text(claim.run_id) && text(claim.at)))
  ) {
    throw new Error(`${name} is not a drained-run claim`);
  }
  return {
    version: 1,
    claim: claim === null ? null : { run_id: claim.run_id as string, at: claim.at as string },
  };
}

function issueText(issue: IssueRef): string {
  return `https://${issue.repo.host}/${issue.repo.path}/issues/${String(issue.number)}`;
}

function outcomeText(decided: Decision): string {
  switch (decided.kind) {
    case 'filed':
      return decided.issue === null ? 'filed, issue not yet created' : `filed ${issueText(decided.issue)}`;
    case 'tracked':
      return `tracked by ${issueText(decided.issue)}${decided.comment === null ? '' : ', evidence comment not yet posted'}`;
    case 'dropped':
      return 'dropped';
    case 'asked':
      return 'asked a maintainer';
  }
}

/**
 * Every decision as one readable document, for the deciding agent and for a person.
 * One section per key, in key order.
 */
export function renderDecisions(records: readonly DecisionRecord[]): string {
  if (records.length === 0) return '# Discovery decisions\n\nNo discovery has been decided yet.\n';
  const sections = [...records]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(record => {
      const runs = [...new Set(record.refs.map(refRun))];
      const lines = [
        `## ${record.key}`,
        '',
        `- ${record.title}`,
        `- Decision: ${outcomeText(record.decision)}`,
        `- Reason: ${record.reason}`,
        `- Verified at ${record.verified_at}, decided ${record.at}, found by ${String(runs.length)} run(s): ${runs.join(', ')}`,
      ];
      if (record.question !== null) {
        lines.push(`- Question: ${record.question.text}`);
        lines.push(`- Recommended: ${record.question.recommendation}`);
        lines.push(
          record.question.answer === null
            ? '- Answer: not yet answered'
            : `- Answer (${record.question.answer.at}): ${record.question.answer.text}`
        );
      }
      return lines.join('\n');
    });
  return `# Discovery decisions\n\n${sections.join('\n\n')}\n`;
}

// --- one pass -------------------------------------------------------------------

export const DRAIN_MODES = ['live', 'eval'] as const;
export type DrainMode = (typeof DRAIN_MODES)[number];

export function parseDrainMode(value: string): DrainMode {
  if ((DRAIN_MODES as readonly string[]).includes(value)) return value as DrainMode;
  throw new Error(`mode must be one of ${DRAIN_MODES.join(', ')}, not "${value}"`);
}

/** One queued run and its undecided records, each ref qualified as `<run-id>:<ref>`. */
export interface QueuedRun {
  readonly id: string;
  readonly workflow: string;
  readonly completed_at: string;
  readonly artifacts: string;
  readonly records: readonly DiscoveryRecord[];
}

export interface Queue {
  readonly mode: DrainMode;
  readonly base: { readonly branch: string; readonly sha: string };
  readonly runs: readonly QueuedRun[];
}

/** The deciding agent's outcomes; the decide node's output schema must admit exactly these. */
export const AGENT_OUTCOMES = ['file', 'track', 'drop', 'ask'] as const;

/** What the deciding agent declared for one discovery, as its output schema admits it. */
export type AgentDecision = {
  readonly key: string;
  readonly refs: readonly string[];
  readonly title: string;
} & (
  | { readonly outcome: 'file'; readonly body: string; readonly reason: string }
  | {
      readonly outcome: 'track';
      readonly issue: IssueRef;
      /** Evidence the issue does not hold yet; null posts nothing. */
      readonly comment: string | null;
      readonly reason: string;
    }
  | { readonly outcome: 'drop'; readonly reason: string }
  | { readonly outcome: 'ask'; readonly question: string; readonly recommendation: string }
);

/**
 * The exact checks before any write: every queued ref is decided exactly once, by a
 * decision whose key is valid and used once; a key that already has an issue is never
 * filed again; and a key whose filing is still unfinished is only filed, so its draft
 * is never overwritten. Returns every violation; an empty list passes.
 */
export function checkDecisions(
  queued: readonly string[],
  decisions: readonly AgentDecision[],
  stored: ReadonlyMap<string, DecisionRecord>
): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  const keys = new Set<string>();
  for (const decision of decisions) {
    if (!isKey(decision.key)) problems.push(`"${decision.key}" is not a valid key`);
    if (keys.has(decision.key)) problems.push(`key ${decision.key} is decided more than once`);
    keys.add(decision.key);
    if (decision.refs.length === 0) problems.push(`key ${decision.key} names no ref`);
    for (const ref of decision.refs) {
      const earlier = seen.get(ref);
      if (earlier !== undefined) problems.push(`${ref} is decided under both ${earlier} and ${decision.key}`);
      seen.set(ref, decision.key);
      if (!queued.includes(ref)) problems.push(`${ref} (key ${decision.key}) is not a queued ref`);
    }
    const prior = stored.get(decision.key)?.decision;
    const issued = (prior?.kind === 'filed' && prior.issue !== null) || prior?.kind === 'tracked';
    if (decision.outcome === 'file' && issued) {
      problems.push(`key ${decision.key} already has an issue; it is never filed again`);
    }
    // A decision that replaced a write the record still owes would lose it.
    if (prior !== undefined && unfinished(prior)) {
      if (prior.kind === 'filed' && decision.outcome !== 'file') {
        problems.push(`key ${decision.key} has an unfinished filing; it can only be filed`);
      }
      if (
        prior.kind === 'tracked' &&
        (decision.outcome !== 'track' || decision.issue.number !== prior.issue.number)
      ) {
        problems.push(`key ${decision.key} has an unposted evidence comment; it can only be tracked on the same issue`);
      }
    }
  }
  for (const ref of queued) if (!seen.has(ref)) problems.push(`${ref} has no decision`);
  return problems;
}

/** The marker on a filed issue's first line, and on an evidence comment's. */
export function discoveryMarker(key: string): string {
  if (!isKey(key)) throw new Error(`"${key}" is not a decision key`);
  return `<!-- archon-discovery ${key} -->`;
}
