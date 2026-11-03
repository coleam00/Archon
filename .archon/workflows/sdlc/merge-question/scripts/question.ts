import { emit, nullableJson, refuse, trimmed } from '../../.shared/io.ts';
import { attentionOptions, checkAttention, renderAttention } from '../../.shared/queue.ts';
import { updateClaimed } from '../../.shared/workitem.ts';
import type { MergeQuestion } from '../../merge-queue/scripts/record.ts';

try {
  const question = nullableJson(process.env.INPUTS_QUESTION) as Pick<MergeQuestion, 'asked' | 'owner_run_id'> | null;
  if (question === null) throw new Error('question is required');
  const { asked } = question;
  checkAttention<string>(asked.attention);
  const runId = trimmed(process.env.WORKFLOW_ID);
  if (runId === '') throw new Error('WORKFLOW_ID is not set; the engine supplies it to every exec node');
  if (asked.by === 'pr') {
    if (question.owner_run_id.trim() === '') throw new Error('owner_run_id is required');
    updateClaimed(asked.item, question.owner_run_id, doc => ({
      ...doc,
      claim: { run_id: runId, at: new Date().toISOString(), requests: doc.claim?.requests ?? [] },
    }));
  }
  emit({
    asked,
    owner_run_id: runId,
    attention: renderAttention(asked.by === 'base'
      ? 'Merge queue: the default branch is red'
      : `Merge queue, PR ${String(asked.pr.number)}: merge decision`, asked.attention),
    options: attentionOptions<string>(asked.attention),
  } satisfies MergeQuestion);
} catch (error) {
  refuse(`merge question: ${error instanceof Error ? error.message : String(error)}`);
}
