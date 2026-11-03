import { emit, nullableJson, refuse, trimmed } from '../../.shared/io.ts';
import { attentionOptions, checkAttention, renderAttention } from '../../.shared/queue.ts';
import { readWorkItem, updateClaimed } from '../../.shared/workitem.ts';
import type { MergeQuestion } from '../../merge-queue/scripts/record.ts';

export type PreparedMergeQuestion = MergeQuestion & {
  readonly attention: string;
  readonly options: { id: string; label: string }[];
};

let question: MergeQuestion | null = null;
try {
  question = nullableJson(process.env.INPUTS_QUESTION) as MergeQuestion | null;
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
  } satisfies PreparedMergeQuestion);
} catch (error) {
  let failure = `merge question: ${error instanceof Error ? error.message : String(error)}`;
  try {
    if (question?.asked.by === 'pr' && readWorkItem(question.asked.item.number)?.claim?.run_id === question.owner_run_id) {
      updateClaimed(question.asked.item, question.owner_run_id, doc => ({ ...doc, claim: null }));
    }
  } catch (releaseError) {
    failure += `; could not release its parent claim: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`;
  }
  refuse(failure);
}
