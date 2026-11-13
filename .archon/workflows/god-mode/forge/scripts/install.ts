/**
 * Open an approved workflow as a draft pull request, or record the rejection.
 * Bound inputs: INPUTS_NAME, INPUTS_DECISION, INPUTS_NOTE, INPUTS_SUMMARY.
 */
import { forgedDir } from '../../.shared/forge.ts';
import { emit, run, text } from '../../.shared/io.ts';
import { publish } from '../../.shared/publish.ts';

run('forge install', () => {
  const name = text(process.env.INPUTS_NAME);
  if (text(process.env.INPUTS_DECISION) !== 'approve') {
    const note = text(process.env.INPUTS_NOTE).trim();
    emit({ installed: false, name, branch: '', commit: '', pr_url: '', reason: `rejected${note ? `: ${note}` : ''}` });
    return;
  }
  const p = publish({
    paths: [forgedDir(name)],
    message: `Forge the ${name} workflow`,
    title: `Add the ${name} workflow`,
    base: process.env.BASE_BRANCH ?? '',
    body: [
      '## Problem and outcome',
      '',
      text(process.env.INPUTS_SUMMARY),
      '',
      '## Validation',
      '',
      '`archon validate workflows` accepts it, and a deterministic dry run reaches an end.',
      '',
      `Written by the \`god-mode-forge\` workflow (run \`${process.env.WORKFLOW_ID ?? ''}\`) and approved by a person before it was opened.`,
    ].join('\n'),
  });
  emit({ installed: true, name, ...p, reason: 'approved and opened as a draft pull request' });
});
