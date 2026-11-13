/**
 * Put the whole diff in front of the person who approves it.
 * Bound inputs: INPUTS_START, INPUTS_TITLE, INPUTS_SUMMARY, INPUTS_REPORT.
 */
import { emit, run, text } from '../../.shared/io.ts';
import { git } from '../../.shared/publish.ts';

run('revise present', () => {
  const start = text(process.env.INPUTS_START);
  // Untracked files have no diff until they are known to git; intent-to-add makes
  // them show up without staging their content.
  git(['add', '--intent-to-add', '--all', '--', '.archon']);
  emit({
    message: [
      `God mode proposes: ${text(process.env.INPUTS_TITLE)}`,
      'Approve to push it and open a draft pull request; reject to discard it.',
      '',
      text(process.env.INPUTS_SUMMARY),
      '',
      text(process.env.INPUTS_REPORT),
      '',
      git(['diff', start, '--', '.archon']),
    ].join('\n'),
  });
});
