/**
 * Replace god mode's memory with the learner's consolidated lessons, guarded by the
 * revision `observe` read. If another run wrote lessons in between, the put exits 3 and
 * this node fails, which is the right outcome: those lessons were never considered.
 * Bound inputs: INPUTS_LESSONS (JSON array), INPUTS_REVISION.
 */
import { statePut } from '../../.shared/archon.ts';
import { emit, json, run, text } from '../../.shared/io.ts';
import { fresh, LESSONS_DOC, MAX_LESSONS } from '../../.shared/lessons.ts';

run('learn consolidate', () => {
  const lessons = fresh([], (json(process.env.INPUTS_LESSONS) as string[] | null) ?? []).slice(0, MAX_LESSONS);
  const at = new Date().toISOString();
  const runId = process.env.WORKFLOW_ID ?? '';
  statePut(LESSONS_DOC, { lessons: lessons.map((t) => ({ at, run: runId, text: t })) }, Number(text(process.env.INPUTS_REVISION)));
  emit({ kept: lessons.length });
});
