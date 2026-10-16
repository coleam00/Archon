import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { forgeSource, parseQualifiedPr } from '../../.shared/forge.ts';
import { gitOrThrow } from '../../.shared/git.ts';
import { artifactsDir, emit, refuse } from '../../.shared/io.ts';
import { viewPr } from '../../.shared/pr.ts';

try {
  const source = forgeSource();
  const target = parseQualifiedPr(process.env.INPUTS_PR);
  const { pr } = viewPr(target, source);
  const reviewed = readFileSync(join(artifactsDir(), 'review/reviewed-head'), 'utf8').trim();
  const allowed =
    pr.state === 'merged' ||
    (pr.state === 'open' &&
      pr.head_revision === reviewed &&
      gitOrThrow('rev-parse', 'HEAD') === reviewed);
  emit({
    allowed,
    pr,
    source,
    summary: allowed
      ? 'The reviewed PR head is current, or the PR is already merged.'
      : `The PR is ${pr.state}; reviewed ${reviewed}, current PR head ${String(pr.head_revision)}. CI cannot promote an unreviewed head.`,
  });
} catch (error) {
  refuse(error instanceof Error ? error.message : String(error));
}
