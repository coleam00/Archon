/**
 * Open an approved revision as a draft pull request, or record the rejection.
 * Bound inputs: INPUTS_DECISION, INPUTS_NOTE, INPUTS_PATHS (JSON array),
 * INPUTS_TITLE, INPUTS_SUMMARY, INPUTS_REPORT, INPUTS_NEED.
 */
import { emit, json, run, text } from '../../.shared/io.ts';
import { publish } from '../../.shared/publish.ts';

run('revise publish', () => {
  if (text(process.env.INPUTS_DECISION) !== 'approve') {
    const note = text(process.env.INPUTS_NOTE).trim();
    emit({ published: false, branch: '', commit: '', pr_url: '', reason: `rejected${note ? `: ${note}` : ''}` });
    return;
  }
  const title = text(process.env.INPUTS_TITLE);
  const p = publish({
    paths: (json(process.env.INPUTS_PATHS) as string[] | null) ?? [],
    message: title,
    title,
    base: process.env.BASE_BRANCH ?? '',
    body: [
      '## Problem and outcome',
      '',
      text(process.env.INPUTS_NEED),
      '',
      '## Solution',
      '',
      text(process.env.INPUTS_SUMMARY),
      '',
      '## Validation',
      '',
      text(process.env.INPUTS_REPORT),
      '',
      `Proposed by the \`god-mode-revise\` workflow (run \`${process.env.WORKFLOW_ID ?? ''}\`) and approved by a person before it was opened.`,
    ].join('\n'),
  });
  emit({ published: true, ...p, reason: 'approved and opened as a draft pull request' });
});
