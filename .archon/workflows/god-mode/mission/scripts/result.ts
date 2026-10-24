/** The mission's terminal, typed outcome: what the conductor and the trust ladder read. */
import { emit, run, text } from '../../.shared/io.ts';

run('mission result', () => {
  const branch = Bun.spawnSync(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' });
  emit({
    mission: text(process.env.INPUTS_ID),
    succeeded: text(process.env.INPUTS_SUCCEEDED) === 'true',
    reason: text(process.env.INPUTS_REASON),
    attempts: Number(text(process.env.INPUTS_ATTEMPTS)) || 0,
    summary: text(process.env.INPUTS_SUMMARY),
    evidence: text(process.env.INPUTS_EVIDENCE).slice(-6000),
    branch: branch.exitCode === 0 ? branch.stdout.toString().trim() : '',
  });
});
