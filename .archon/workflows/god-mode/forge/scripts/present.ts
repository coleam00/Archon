/**
 * Put the whole forged workflow in front of the person who approves it: they approve
 * what will run, not a summary of it.
 * Bound inputs: INPUTS_NAME, INPUTS_SUMMARY, INPUTS_REPORT.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { forgedDir } from '../../.shared/forge.ts';
import { emit, run, text } from '../../.shared/io.ts';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

run('forge present', () => {
  const name = text(process.env.INPUTS_NAME);
  const body = files(forgedDir(name))
    .sort()
    .map((p) => `--- ${p}\n${readFileSync(p, 'utf8')}`)
    .join('\n');
  emit({
    message: [
      `The forge built \`${name}\`. Approve to push it and open a draft pull request; reject to discard it.`,
      '',
      text(process.env.INPUTS_SUMMARY),
      '',
      text(process.env.INPUTS_REPORT),
      '',
      body,
    ].join('\n'),
  });
});
