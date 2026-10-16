/**
 * A conditional decision-record write claims one pause before its queue write.
 * Incomplete records remain owned until the engine reports the manager terminal.
 */

import { createHash } from 'node:crypto';
import { record } from './forge.ts';
import { ATTENTION_ESCALATED } from './labels.ts';
import { CONFIDENCES } from './queue.ts';
import { archon, claimDisposition, failed, runStatus } from './state.ts';
import { oneOf } from './workitem.ts';

export const AUTONOMIES = ['none', 'answer'] as const;
export type Autonomy = (typeof AUTONOMIES)[number];

/** The `autonomy` input; empty means `none`, which never answers. */
export function parseAutonomy(text: string): Autonomy {
  return oneOf('autonomy', AUTONOMIES, text);
}

/** A `select` attention item, as far as the manager reads it. */
export interface QueueItem {
  readonly runId: string;
  readonly workflow: string;
  readonly node: string;
  readonly occurrence: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly pausedAt: string;
  readonly message: string;
  readonly options: readonly { readonly id: string; readonly label?: string }[];
  readonly context: { readonly artifactsDir: string };
}

export const DECISIONS_PREFIX = 'attention-manager/decisions/';

const STATE_NAME = /^[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/;
const STATE_NAME_MAX = 200;

/** The decision record's state document for one pause occurrence. */
export function recordName(runId: string, occurrence: string): string {
  const raw = `${DECISIONS_PREFIX}${runId}/${occurrence}`;
  const key = STATE_NAME.test(occurrence) && !occurrence.startsWith('encoded-') && raw.length <= STATE_NAME_MAX
    ? occurrence
    : `encoded-${createHash('sha256').update(occurrence).digest('hex')}`;
  const name = `${DECISIONS_PREFIX}${runId}/${key}`;
  if (!STATE_NAME.test(name) || name.length > STATE_NAME_MAX) {
    throw new Error(`run ${runId} occurrence ${occurrence} does not make a state document name`);
  }
  return name;
}

function field(value: Record<string, unknown>, name: string): string {
  const read = value[name];
  if (typeof read !== 'string' || read === '') throw new Error(`the item has no ${name}`);
  return read;
}

/** A queue entry the manager may decide; anything else refuses, naming the field. */
export function parseQueueItem(value: unknown): QueueItem {
  const item = record(value);
  if (item === undefined) throw new Error('the item is not an object');
  if (item.kind !== 'attention') throw new Error(`the item is a ${String(item.kind)} item, not an attention item`);
  if (item.form !== 'select') throw new Error(`the item's form is ${String(item.form)}, not select`);
  const runId = field(item, 'runId');
  const occurrence = field(item, 'occurrence');
  recordName(runId, occurrence);
  const labels = record(item.labels);
  if (labels === undefined || !Object.values(labels).every(label => typeof label === 'string')) {
    throw new Error('the item has no labels object');
  }
  const options = Array.isArray(item.options) ? item.options.map(record) : [];
  if (options.length === 0 || !options.every(option => typeof option?.id === 'string' && option.id !== '')) {
    throw new Error('the item declares no options');
  }
  const artifactsDir = record(item.context)?.artifactsDir;
  if (typeof artifactsDir !== 'string' || artifactsDir === '') {
    throw new Error('the item has no context.artifactsDir');
  }
  return {
    runId,
    workflow: field(item, 'workflow'),
    node: field(item, 'node'),
    occurrence,
    labels: labels as Record<string, string>,
    pausedAt: field(item, 'pausedAt'),
    message: field(item, 'message'),
    options: options.map(option => ({
      id: option?.id as string,
      ...(typeof option?.label === 'string' ? { label: option.label } : {}),
    })),
    context: { artifactsDir },
  };
}

export function isEscalated(labels: Readonly<Record<string, unknown>>): boolean {
  return labels[ATTENTION_ESCALATED.key] === ATTENTION_ESCALATED.value;
}

/** A pending write belongs to its live owner; only terminal owners permit recovery. */
export function blocksDecision(value: unknown): boolean {
  if (value === null) return false;
  const stored = record(value);
  if (record(stored?.applied)?.result === 'ok') return true;
  return typeof stored?.run_id !== 'string' || claimDisposition(runStatus(stored.run_id)) === 'hold';
}

/** The deciding agent's output, as its node's schema certified it. */
export interface AgentDecision {
  readonly decision: 'answer' | 'escalate';
  /** On answer, a declared option id; on escalate, the one it would recommend, or empty. */
  readonly choice: string;
  readonly ruling: string;
  readonly sources: readonly string[];
  readonly confidence: (typeof CONFIDENCES)[number];
  readonly reason: string;
}

export type Outcome = 'answered' | 'escalated' | 'recommended';

/**
 * What the manager does with the agent's decision. An answer that names an undeclared
 * choice, cites nothing or is low confidence is escalated, with the reason in
 * `override`. Escalating labels the item in both autonomy modes; `none` only never answers.
 */
export function resolveOutcome(
  item: QueueItem,
  agent: AgentDecision,
  autonomy: Autonomy
): { outcome: Outcome; override: string } {
  if (agent.decision === 'escalate') return { outcome: 'escalated', override: '' };
  if (!item.options.some(option => option.id === agent.choice)) {
    return { outcome: 'escalated', override: `the agent chose "${agent.choice}", which the item does not declare` };
  }
  if (agent.sources.length === 0) {
    return { outcome: 'escalated', override: 'an answer must cite the document or ruling it rests on' };
  }
  if (agent.confidence === 'low') return { outcome: 'escalated', override: 'the agent answered at low confidence' };
  return { outcome: autonomy === 'answer' ? 'answered' : 'recommended', override: '' };
}

/**
 * The text the answer carries. The asking workflow records it with the choice's own
 * ruling, so it says who answered and from what.
 */
export function answerText(managerRunId: string, agent: AgentDecision): string {
  return `The attention manager answered this from the project's documents (run ${managerRunId}): ${agent.ruling.trim()}\n\nSources: ${agent.sources.join('; ')}`;
}

export type Write =
  | { readonly answer: { readonly choice: string; readonly text: string } }
  | { readonly label: Readonly<Record<string, string>> };

/** The one queue write an outcome makes. */
export function writeFor(outcome: Outcome, managerRunId: string, agent: AgentDecision): Write {
  switch (outcome) {
    case 'answered':
      return { answer: { choice: agent.choice, text: answerText(managerRunId, agent) } };
    case 'recommended':
    case 'escalated':
      return { label: { [ATTENTION_ESCALATED.key]: ATTENTION_ESCALATED.value } };
  }
}

export interface DecisionRecord {
  readonly version: 1;
  readonly at: string;
  /** The manager run that decided. */
  readonly run_id: string;
  readonly autonomy: Autonomy;
  readonly item: {
    readonly run_id: string;
    readonly workflow: string;
    readonly node: string;
    readonly occurrence: string;
    readonly labels: Readonly<Record<string, string>>;
    readonly paused_at: string;
    readonly message: string;
  };
  readonly outcome: Outcome;
  readonly agent: AgentDecision;
  /** Why the manager escalated an answer the agent gave; empty otherwise. */
  readonly override: string;
  /** Null until the write was made; it stays null when the run stopped before it. */
  readonly applied: null | {
    readonly at: string;
    readonly result: 'ok' | 'refused' | 'unconfirmed';
    readonly detail: string;
  };
}

// --- the queue, through the host CLI ------------------------------------------------

/** The project's open queue items, oldest first, as `workflow attention --json` lists them. */
export function listQueue(): unknown[] {
  const result = archon(['workflow', 'attention', '--json']);
  const value = record(result.value);
  if (result.code !== 0 || value?.ok !== true || !Array.isArray(value.items)) {
    throw failed('workflow attention', result);
  }
  if (record(value.scope)?.kind !== 'project') {
    throw new Error('archon workflow attention did not scope the queue to this project');
  }
  return value.items;
}

/** The item a run stands for now, or null when it is paused at nothing. */
export function readItem(runId: string): Record<string, unknown> | null {
  const result = archon(['workflow', 'attention', runId, '--json']);
  const value = record(result.value);
  if (result.code !== 0 || value?.ok !== true) throw failed(`workflow attention ${runId}`, result);
  return record(value.item) ?? null;
}

export type WriteResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** A structured refusal is returned for the caller to verify against the current pause. */
function queueWrite(what: string, args: readonly string[]): WriteResult {
  const result = archon(args);
  const value = record(result.value);
  if (result.code === 0 && value?.ok === true) return { ok: true };
  if (value?.ok === false && typeof value.error === 'string') return { ok: false, error: value.error };
  throw failed(what, result);
}

export function answerItem(item: QueueItem, choice: string, text: string): WriteResult {
  return queueWrite(`workflow answer ${item.runId}`, [
    'workflow',
    'answer',
    item.runId,
    '--occurrence',
    item.occurrence,
    '--choose',
    choice,
    '--text',
    text,
    '--json',
  ]);
}

export function labelEscalated(item: QueueItem): WriteResult {
  return queueWrite(`workflow attention label ${item.runId}`, [
    'workflow',
    'attention',
    'label',
    item.runId,
    '--occurrence',
    item.occurrence,
    '--set',
    `${ATTENTION_ESCALATED.key}=${ATTENTION_ESCALATED.value}`,
    '--json',
  ]);
}
