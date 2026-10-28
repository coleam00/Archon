/**
 * The host CLI for intake and discoveries script tests: `workflow get <id> --json`
 * answers from the status table in `INTAKE_RUN_STATUSES`, `workflow runs --json` from
 * the rows in `RUN_LISTING`, and `workflow run <name>` acknowledges `launched-<name>`
 * without starting anything (or refuses, exit 1, when `ARCHON_RUN_REFUSES` is set); every other command runs the real CLI, whose argv the test
 * passes as a JSON array in `INTAKE_HOST_CLI` (`ARCHON_CLI_COMMAND` names this fake).
 *
 * When `ARCHON_CALL_LOG` names a file, each call's argv is appended to it as a JSON line.
 *
 * The real CLI runs as a surface write, outside any run, in `INTAKE_STATE_CWD` when
 * set: inside a run it would refuse with exit 5, because its store has no such run.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
if (process.env.ARCHON_CALL_LOG) appendFileSync(process.env.ARCHON_CALL_LOG, `${JSON.stringify(argv)}\n`);
if (argv[0] === 'workflow' && argv[1] === 'runs') {
  // The project's run listing, from `RUN_LISTING` (a JSON array of run rows).
  const runs = JSON.parse(process.env.RUN_LISTING ?? '[]') as unknown[];
  process.stdout.write(JSON.stringify({ runs, total: runs.length, scopeFallback: false }));
} else if (argv[0] === 'workflow' && argv[1] === 'run') {
  if (process.env.ARCHON_RUN_REFUSES) {
    process.stderr.write('refused');
    process.exitCode = 1;
  } else process.stdout.write(JSON.stringify({ runId: `launched-${argv[2]}` }));
} else if (argv[0] === 'workflow' && argv[1] === 'get') {
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
  if (!process.env.INTAKE_HOST_CLI) throw new Error('INTAKE_HOST_CLI names no host CLI');
  const [command, ...prefix] = JSON.parse(process.env.INTAKE_HOST_CLI) as string[];
  const result = spawnSync(command, [...prefix, ...argv], {
    cwd: process.env.INTAKE_STATE_CWD || process.cwd(),
    env: { ...process.env, WORKFLOW_ID: '', ARCHON_NODE_EXECUTION: '' },
    input: readFileSync(0),
    encoding: 'utf8',
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
}
