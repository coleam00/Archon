/**
 * A stand-in for the GitHub forge plugin as release v0.11.1 shipped it: the same
 * capabilities and token names, so the host refuses every operation that release
 * lacks. It answers `pr.view` for a token it accepts and refuses any other.
 */
import { readFileSync } from 'node:fs';

const ACCEPTED_TOKEN = 'accepted';

if (process.argv.includes('metadata')) {
  process.stdout.write(
    JSON.stringify({
      protocol: 1,
      name: 'github',
      version: '1',
      forge: 'github',
      hosts: ['ghe.example.com'],
      capabilities: [
        'resolve',
        'checks.state',
        'workitem.view',
        'pr.view',
        'pr.create',
        'pr.edit-body',
        'pr.ready',
        'comment.upsert',
      ],
      token_env: ['GH_TOKEN', 'GITHUB_TOKEN'],
    })
  );
  process.exit(0);
}

const request = JSON.parse(readFileSync(0, 'utf8')) as { op: string; operationId: string };
if (request.op !== 'pr.view') throw new Error(`the stub does not answer ${request.op}`);
const accepted = process.env.ARCHON_FORGE_TOKEN === ACCEPTED_TOKEN;
process.stdout.write(
  JSON.stringify(
    accepted
      ? { operationId: request.operationId, ok: true, result: { op: 'pr.view', value: null } }
      : {
          operationId: request.operationId,
          ok: false,
          error: { kind: 'authorization', message: 'Bad credentials', status: 401 },
        }
  )
);
process.exitCode = accepted ? 0 : 1;
