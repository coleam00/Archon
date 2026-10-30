/** Read god mode's memory so this mission starts from what earlier runs learned. */
import { stateGet } from '../../.shared/archon.ts';
import { emit, run } from '../../.shared/io.ts';
import { LESSONS_DOC, type LessonsDoc, recall } from '../../.shared/lessons.ts';

run('mission recall', () => {
  emit({ lessons: recall(stateGet<LessonsDoc>(LESSONS_DOC).value) });
});
