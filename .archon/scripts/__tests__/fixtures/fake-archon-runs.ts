/**
 * The host CLI for intake script tests: `workflow get <id> --json` answers from the
 * status table in `INTAKE_RUN_STATUSES`; every other command runs the real CLI.
 *
 * The real CLI runs as a surface write, outside any run, in `INTAKE_STATE_CWD` when
 * set: inside a run it would refuse with exit 5, because its store has no such run.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
if (argv[0] === 'workflow' && argv[1] === 'get') {
  const statuses = JSON.parse(process.env.INTAKE_RUN_STATUSES ?? '{}') as Record<string, string>;
  const status = statuses[argv[2]];
  process.stdout.write(
    JSON.stringify(
      status === undefined
        ? { ok: false, runId: argv[2], error: 'not_found' }
        : { id: argv[2], status }
    )
  );
  process.exitCode = status === undefined ? 1 : 0;
} else {
  const result = spawnSync(
    process.execPath,
    ['--no-env-file', resolve(import.meta.dir, '../../../../packages/cli/src/cli.ts'), ...argv],
    {
      cwd: process.env.INTAKE_STATE_CWD || process.cwd(),
      env: { ...process.env, WORKFLOW_ID: '', ARCHON_NODE_EXECUTION: '' },
      input: readFileSync(0),
      encoding: 'utf8',
    }
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
}
