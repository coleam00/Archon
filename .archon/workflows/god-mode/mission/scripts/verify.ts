/**
 * Run the mission's acceptance commands in the mission's checkout and report a typed
 * verdict. Always exits 0: the attempt decides what a failure means.
 *
 * Bound input: INPUTS_ACCEPTANCE, the JSON array of commands.
 */
import { emit, json, run } from '../../.shared/io.ts';

/** Output kept per command: enough to diagnose, small enough to feed back. */
const TAIL = 4000;

run('mission verify', () => {
  const commands = json(process.env.INPUTS_ACCEPTANCE) as string[];
  let pass = true;
  const sections: string[] = [];
  for (const command of commands) {
    const proc = Bun.spawnSync(['bash', '-o', 'pipefail', '-c', command], { stdout: 'pipe', stderr: 'pipe' });
    const code = proc.exitCode ?? 1;
    if (code !== 0) pass = false;
    const out = `${proc.stdout.toString()}${proc.stderr.toString()}`;
    sections.push(`$ ${command}\nexit ${code}\n${out.length > TAIL ? `…${out.slice(-TAIL)}` : out}`);
  }
  emit({ pass, report: `${sections.join('\n\n')}\n\nVERIFICATION: ${pass ? 'PASS' : 'FAIL'}` });
});
