/**
 * Turn the agent's decision into the outcome, record it, make the one queue write and
 * read it back.
 *
 * Live: the item is read again first, and one that was answered, moved to another
 * pause or escalated since facts read it is left alone. The decision record is created
 * with a conditional write before the queue write, so a run that loses the create
 * writes nothing. An answer goes through `workflow answer` with the declared choice; an
 * escalation or recommendation sets the escalation label.
 * The result is then patched onto the record. A write the queue refuses because the
 * pause moved is recorded and ends the run as `moved`; a write it accepted that does
 * not read back fails the run. Incomplete writes retry only after their owner is terminal.
 *
 * Eval writes nothing and returns the outcome and the write live would make.
 *
 * Bound inputs: INPUTS_PATH and INPUTS_ITEM from facts; INPUTS_DECISION from the agent,
 * `null` when it did not run; the workflow's INPUTS_MODE and INPUTS_AUTONOMY.
 */

import {
  type AgentDecision,
  answerItem,
  blocksDecision,
  type DecisionRecord,
  isEscalated,
  labelEscalated,
  parseAutonomy,
  parseQueueItem,
  type QueueItem,
  readItem,
  recordName,
  resolveOutcome,
  type Write,
  writeFor,
} from '../../.shared/attention.ts';
import { record } from '../../.shared/forge.ts';
import { emit, nullableJson, refuse, text, trimmed } from '../../.shared/io.ts';
import { stateGet, statePatch, statePut } from '../../.shared/state.ts';
import { parseMode } from '../../.shared/workitem.ts';

type Emitted = 'idle' | 'answered' | 'escalated' | 'recommended' | 'moved';

function finish(decision: Emitted, summary: string, name: string, evaluation: unknown = null): void {
  emit({ decision, summary, record: name, evaluation });
}

/** Whether the item still waits at the pause facts read, unanswered and not escalated. */
function stillOpen(item: QueueItem, now: Record<string, unknown> | null): boolean {
  return now !== null && now.occurrence === item.occurrence && !isEscalated(record(now.labels) ?? {});
}

/** What the queue reads after the write, when the write landed; a description of it otherwise. */
function readBack(item: QueueItem, write: Write): string | null {
  const now = readItem(item.runId);
  if ('answer' in write) {
    return now === null || now.occurrence !== item.occurrence ? null : 'the item is still open at the same pause';
  }
  return now !== null && now.occurrence === item.occurrence && isEscalated(record(now.labels) ?? {})
    ? null
    : `the item reads ${now === null ? 'closed' : `labels ${JSON.stringify(now.labels)}`}`;
}

function main(): void {
  const mode = parseMode(trimmed(process.env.INPUTS_MODE));
  const autonomy = parseAutonomy(trimmed(process.env.INPUTS_AUTONOMY));
  if (trimmed(process.env.INPUTS_PATH) === 'idle') {
    finish('idle', 'No open attention item is for the attention manager to decide.', '');
    return;
  }
  const item = parseQueueItem(nullableJson(process.env.INPUTS_ITEM));
  const agent = nullableJson(process.env.INPUTS_DECISION) as AgentDecision | null;
  if (agent === null) throw new Error('the item reached apply without a decision');
  const self = text(process.env.WORKFLOW_ID);
  if (self === '') throw new Error('WORKFLOW_ID is not set; the engine supplies it to every exec node');

  const { outcome, override } = resolveOutcome(item, agent, autonomy);
  const write = writeFor(outcome, self, agent);
  const subject = `Run ${item.runId} (${item.workflow}, ${item.node})`;
  const said = `${outcome}${outcome === 'escalated' ? '' : ` with ${agent.choice}`}${override === '' ? '' : `: ${override}`}`;

  if (mode === 'eval') {
    finish(outcome, `${subject}: ${said}; eval writes nothing.`, '', {
      item: { run_id: item.runId, workflow: item.workflow, labels: item.labels },
      agent,
      outcome,
      override,
      write,
    });
    return;
  }

  if (!stillOpen(item, readItem(item.runId))) {
    finish('moved', `${subject}: answered, moved or escalated since it was picked; nothing written.`, '');
    return;
  }
  const name = recordName(item.runId, item.occurrence);
  const stored = stateGet(name);
  const at = new Date().toISOString();
  const decided: DecisionRecord = {
    version: 1,
    at,
    run_id: self,
    autonomy,
    item: {
      run_id: item.runId,
      workflow: item.workflow,
      node: item.node,
      occurrence: item.occurrence,
      labels: item.labels,
      paused_at: item.pausedAt,
      message: item.message,
    },
    outcome,
    agent,
    override,
    applied: null,
  };
  if (blocksDecision(stored.value) || statePut(name, decided, stored.revision) === 'conflict') {
    finish('moved', `${subject}: another run decided it; nothing written.`, name);
    return;
  }

  const result = 'answer' in write ? answerItem(item, write.answer.choice, write.answer.text) : labelEscalated(item);
  const recordApplied = (applied: DecisionRecord['applied']): void =>
    statePatch(name, [{ op: 'set', path: '/applied', value: applied }]);
  if (!result.ok) {
    recordApplied({ at: new Date().toISOString(), result: 'refused', detail: result.error });
    if (stillOpen(item, readItem(item.runId))) {
      throw new Error(`${subject}: the queue refused the write at the still-open pause (${result.error})`);
    }
    finish('moved', `${subject}: the queue refused the write (${result.error}); recorded.`, name);
    return;
  }
  const disagrees = readBack(item, write);
  if (disagrees !== null) {
    recordApplied({ at: new Date().toISOString(), result: 'unconfirmed', detail: disagrees });
    throw new Error(`${subject}: the queue accepted the write but ${disagrees}`);
  }
  recordApplied({ at: new Date().toISOString(), result: 'ok', detail: '' });
  finish(outcome, `${subject}: ${said}.`, name);
}

try {
  main();
} catch (error) {
  refuse(`attention-manager apply: ${error instanceof Error ? error.message : String(error)}`);
}
