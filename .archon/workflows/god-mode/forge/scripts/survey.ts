/** The workflows that already exist, so the author extends rather than duplicates. */
import { cliJson } from '../../.shared/archon.ts';
import { emit, run } from '../../.shared/io.ts';

interface Listed {
  name: string;
  description: string;
}

run('forge survey', () => {
  const listed = cliJson(['workflow', 'list', '--json']) as { workflows: Listed[] };
  const catalog = listed.workflows
    .map((w) => `- ${w.name}: ${w.description.split('\n')[0] ?? ''}`)
    .join('\n');
  emit({ catalog });
});
