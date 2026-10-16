import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { archonCommand, forgeSource, parseQualifiedPr } from '../../.shared/forge.ts';
import { gitOrThrow } from '../../.shared/git.ts';
import { artifactsDir, emit, refuse } from '../../.shared/io.ts';
import { viewPr } from '../../.shared/pr.ts';

function checkTarget() {
  const source = forgeSource();
  const target = parseQualifiedPr(process.env.INPUTS_PR);
  if (source === 'forge') archonCommand();
  const reviewed = readFileSync(join(artifactsDir(), 'review/reviewed-head'), 'utf8').trim();
  let view: ReturnType<typeof viewPr>;
  try {
    view = viewPr(target, source);
  } catch (error) {
    return {
      allowed: false,
      pr: target,
      source,
      summary: `The PR read failed; CI was not started. ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const { pr } = view;
  const allowed =
    pr.state === 'merged' ||
    (pr.state === 'open' &&
      pr.head_revision === reviewed &&
      gitOrThrow('rev-parse', 'HEAD') === reviewed);
  return {
    allowed,
    pr,
    source,
    summary: allowed
      ? 'The reviewed PR head is current, or the PR is already merged.'
      : `The PR is ${pr.state}; reviewed ${reviewed}, current PR head ${String(pr.head_revision)}. CI cannot promote an unreviewed head.`,
  };
}

try {
  emit(checkTarget());
} catch (error) {
  refuse(error instanceof Error ? error.message : String(error));
}
