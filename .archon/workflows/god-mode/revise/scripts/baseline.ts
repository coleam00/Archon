/** Record where the revision starts and what was already failing before it. */
import { emit, run } from '../../.shared/io.ts';
import { git } from '../../.shared/publish.ts';
import { snapshot } from '../../.shared/snapshot.ts';

run('revise baseline', () => {
  emit({ start: git(['rev-parse', 'HEAD']), ...snapshot() });
});
