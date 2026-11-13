/**
 * Commit the debrief's lessons to god mode's memory and author the run's verdict.
 * Bound inputs: INPUTS_LESSONS (JSON array), INPUTS_SUCCEEDED, INPUTS_SUMMARY.
 */
import { stateGet, statePatch } from '../../.shared/archon.ts';
import { emit, json, run, text } from '../../.shared/io.ts';
import { fresh, LESSONS_DOC, type LessonsDoc } from '../../.shared/lessons.ts';

run('god-mode remember', () => {
  const candidates = (json(process.env.INPUTS_LESSONS) as string[] | null) ?? [];
  const existing = stateGet<LessonsDoc>(LESSONS_DOC).value?.lessons ?? [];
  const add = fresh(existing, candidates);
  if (add.length > 0) {
    const at = new Date().toISOString();
    const runId = process.env.WORKFLOW_ID ?? '';
    statePatch(LESSONS_DOC, add.map((t) => ({ op: 'append' as const, path: '/lessons', value: { at, run: runId, text: t } })));
  }
  emit({
    succeeded: text(process.env.INPUTS_SUCCEEDED) === 'true',
    summary: text(process.env.INPUTS_SUMMARY),
    remembered: add.length,
  });
});
