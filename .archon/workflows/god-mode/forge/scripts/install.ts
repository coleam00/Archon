/**
 * Commit an approved workflow to this run's branch, or record the rejection.
 * Bound inputs: INPUTS_NAME, INPUTS_DECISION, INPUTS_NOTE.
 */
import { forgedDir } from '../../.shared/forge.ts';
import { emit, run, text } from '../../.shared/io.ts';

function git(args: string[]): string {
  const proc = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${proc.stderr.toString().trim()}`);
  return proc.stdout.toString().trim();
}

run('forge install', () => {
  const name = text(process.env.INPUTS_NAME);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (text(process.env.INPUTS_DECISION) !== 'approve') {
    const note = text(process.env.INPUTS_NOTE).trim();
    emit({ installed: false, name, branch, commit: '', reason: `rejected${note ? `: ${note}` : ''}` });
    return;
  }
  const dir = forgedDir(name);
  git(['add', '--', dir]);
  git(['commit', '-m', `Forge the ${name} workflow`, '--', dir]);
  emit({ installed: true, name, branch, commit: git(['rev-parse', 'HEAD']), reason: 'approved and committed' });
});
