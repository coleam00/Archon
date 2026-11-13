/**
 * Decide whether this revision may go to a person. Always exits 0: a rejected
 * revision is feedback for the next attempt.
 * Bound inputs: INPUTS_START, INPUTS_BASELINE, INPUTS_ACCEPTANCE (JSON array),
 * INPUTS_TITLE, INPUTS_SUMMARY, INPUTS_PREVIOUS (empty on the first attempt).
 */
import { emit, json, run, text } from '../../.shared/io.ts';
import { changedSince } from '../../.shared/publish.ts';
import { governance, judgeRevision, regressions, type Snapshot } from '../../.shared/revise.ts';
import { snapshot } from '../../.shared/snapshot.ts';

const TAIL = 3000;

run('revise check', () => {
  const previousRaw = json(process.env.INPUTS_PREVIOUS);
  const previous = typeof previousRaw === 'number' ? previousRaw : 0;
  const paths = changedSince(text(process.env.INPUTS_START));
  const problems = governance(paths);
  // Health is only worth measuring for a change that is allowed at all.
  const regressed =
    paths.length > 0 && problems.length === 0
      ? regressions(json(process.env.INPUTS_BASELINE) as Snapshot, snapshot())
      : [];
  const commands = (json(process.env.INPUTS_ACCEPTANCE) as string[] | null) ?? [];
  const acceptance = commands.map((command) => {
    const proc = Bun.spawnSync(['bash', '-o', 'pipefail', '-c', command], { stdout: 'pipe', stderr: 'pipe' });
    const out = `${proc.stdout.toString()}${proc.stderr.toString()}`;
    return { command, code: proc.exitCode ?? 1, output: out.length > TAIL ? `…${out.slice(-TAIL)}` : out };
  });
  emit({
    ...judgeRevision(previous, paths, problems, regressed, acceptance),
    paths,
    title: text(process.env.INPUTS_TITLE),
    summary: text(process.env.INPUTS_SUMMARY),
  });
});
