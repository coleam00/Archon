/**
 * The discoveries workflow's state: one decision record per decided discovery, and
 * one document per drained run.
 *
 * `discoveries/decisions/<key>` holds what was decided about one discovery, under a
 * short key the deciding agent chose, with every run that found it. It is the
 * workflow's memory: the agent reads all of them before deciding, so a discovery
 * already handled is not handled again, and a maintainer's answer applies to later
 * items. One small document per key keeps every write well under the store's
 * document cap.
 *
 * `discoveries/runs/<run-id>` is a drained run's work item: the claim of the pass
 * working it and which key each of its records was decided under.
 */

import type { QualifiedPr } from './forge.ts';
import type { DiscoveryRecord } from './report.ts';
import { isObject } from './typed.ts';

export const DECISIONS_PREFIX = 'discoveries/decisions/';
export const RUNS_PREFIX = 'discoveries/runs/';
const KEY = /^[a-z0-9][a-z0-9-]{2,80}$/;

export type IssueRef = QualifiedPr;

/**
 * What became of a discovery. A `filed` decision carries its draft until the issue
 * exists, so a pass that stopped between the two finishes the same issue by its
 * marker rather than filing a second one.
 */
export type Decision =
  | {
      readonly kind: 'filed';
      readonly issue: IssueRef | null;
      readonly draft: { readonly title: string; readonly body: string } | null;
    }
  | { readonly kind: 'tracked'; readonly issue: IssueRef; readonly comment_url: string | null }
  | { readonly kind: 'dropped' }
  | { readonly kind: 'asked' };

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
  /** Every run that found this discovery, oldest first. */
  readonly runs: readonly string[];
  /** The last question asked about it, with its answer once there is one. */
  readonly question: Question | null;
}

export interface RunDoc {
  readonly version: 1;
  readonly claim: { readonly run_id: string; readonly at: string } | null;
  /** Each decided record's ref, mapped to the key it was decided under. */
  readonly decided: Readonly<Record<string, string>>;
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

function text(value: unknown): value is string {
  return typeof value === 'string';
}

function issueRef(value: unknown): IssueRef | undefined {
  if (!isObject(value) || !isObject(value.repo)) return undefined;
  const { host, path } = value.repo;
  return text(host) && host !== '' && text(path) && path !== '' &&
    typeof value.number === 'number' && Number.isInteger(value.number) && value.number > 0
    ? { repo: { host, path }, number: value.number }
    : undefined;
}

function decision(value: unknown): Decision | undefined {
  if (!isObject(value)) return undefined;
  switch (value.kind) {
    case 'filed': {
      const issue = value.issue === null ? null : issueRef(value.issue);
      const draft =
        value.draft === null
          ? null
          : isObject(value.draft) && text(value.draft.title) && text(value.draft.body)
            ? { title: value.draft.title, body: value.draft.body }
            : undefined;
      // Exactly one of the two: the draft is the issue until the issue exists.
      if (issue === undefined || draft === undefined || (issue === null) === (draft === null)) {
        return undefined;
      }
      return { kind: 'filed', issue, draft };
    }
    case 'tracked': {
      const issue = issueRef(value.issue);
      if (issue === undefined || !(value.comment_url === null || text(value.comment_url))) {
        return undefined;
      }
      return { kind: 'tracked', issue, comment_url: value.comment_url };
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
    !Array.isArray(value.runs) ||
    !value.runs.every(text)
  ) {
    return fail('a title, reason, verified_at, at or runs field is missing');
  }
  return {
    version: 1,
    key: value.key,
    title: value.title,
    decision: parsed,
    reason: value.reason,
    verified_at: value.verified_at,
    at: value.at,
    runs: value.runs,
    question: asked,
  };
}

/** A drained run's document; null when there is none yet. */
export function parseRunDoc(name: string, value: unknown): RunDoc | null {
  if (value === null) return null;
  const claim = isObject(value) ? value.claim : undefined;
  const decided = isObject(value) ? value.decided : undefined;
  if (
    !isObject(value) ||
    value.version !== 1 ||
    !(claim === null || (isObject(claim) && text(claim.run_id) && text(claim.at))) ||
    !isObject(decided) ||
    !Object.values(decided).every(isKey)
  ) {
    throw new Error(`${name} is not a drained-run document`);
  }
  return {
    version: 1,
    claim: claim === null ? null : { run_id: claim.run_id as string, at: claim.at as string },
    decided: decided as Record<string, string>,
  };
}

function issueText(issue: IssueRef): string {
  return `https://${issue.repo.host}/${issue.repo.path}/issues/${String(issue.number)}`;
}

function outcomeText(record: DecisionRecord): string {
  const decided = record.decision;
  switch (decided.kind) {
    case 'filed':
      return decided.issue === null ? 'filed, issue not yet created' : `filed ${issueText(decided.issue)}`;
    case 'tracked':
      return `tracked by ${issueText(decided.issue)}${decided.comment_url === null ? '' : ` (evidence ${decided.comment_url})`}`;
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
      const lines = [
        `## ${record.key}`,
        '',
        `- ${record.title}`,
        `- Decision: ${outcomeText(record)}`,
        `- Reason: ${record.reason}`,
        `- Verified at ${record.verified_at}, decided ${record.at}, found by ${String(record.runs.length)} run(s): ${record.runs.join(', ')}`,
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

/** The run a qualified ref belongs to. */
export function refRun(ref: string): string {
  const colon = ref.indexOf(':');
  if (colon <= 0) throw new Error(`"${ref}" is not a qualified discovery ref`);
  return ref.slice(0, colon);
}

/** What the deciding agent declared for one discovery, as its output schema admits it. */
export type AgentDecision = { readonly key: string; readonly refs: readonly string[]; readonly title: string } & (
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
 * decision whose key is valid and used once, and a key that already has an issue is
 * never filed again. Returns every violation; an empty list passes.
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
    const record = stored.get(decision.key);
    const issued =
      record !== undefined &&
      ((record.decision.kind === 'filed' && record.decision.issue !== null) ||
        record.decision.kind === 'tracked');
    if (decision.outcome === 'file' && issued) {
      problems.push(`key ${decision.key} already has an issue; it is never filed again`);
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
