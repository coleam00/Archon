/**
 * The host CLI for the pull-request facts test. The forge is the fake: `forge resolve`
 * reads a pull request URL, and `forge pr.view` answers from `$FAKE_DIR/prs.json`, a map
 * of pull request number to what the forge reports. `state` is the real CLI's, named by
 * `FAKE_HOST_CLI` and run in `FAKE_STATE_CWD`, as a surface write outside any run (inside
 * one it would refuse with exit 5, because its store has no such run), so the revision
 * rule and the deleted documents are the store's own. Only `state put` is intercepted, by
 * two files in `$FAKE_DIR`: `put-fails` makes it fail (exit 1), and `put-conflicts` has
 * another run win first, the real CLI writing the same document at the revision the
 * caller names, so the store then refuses the caller's write. Every call's argv is
 * appended to `calls.log`, a `forge pr.view` with its pull request number.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_DIR as string;
const argv = process.argv.slice(2);
interface Request {
  readonly remote?: string;
  readonly selector?: { readonly ref: { readonly repo: { readonly host: string; readonly path: string }; readonly number: number } };
}
/** What the forge reports of one pull request, as `prs.json` holds it. */
interface Reported {
  readonly state: string;
  readonly head: string;
  readonly created: string;
  readonly merged?: string;
  readonly closed?: string;
}
const dataFile = argv.indexOf('--data-file');
const request: Request = dataFile >= 0 ? (JSON.parse(readFileSync(argv[dataFile + 1], 'utf8')) as Request) : {};
const out = (value: unknown): void => void process.stdout.write(JSON.stringify(value));
const done = (op: string, value: unknown): void => out({ operationId: `op-${op}`, ok: true, result: { op, value } });

const label = argv[0] === 'forge' && argv[1] === 'pr.view' ? `forge pr.view ${String(request.selector?.ref.number)}` : argv.slice(0, 2).join(' ');
appendFileSync(join(dir, 'calls.log'), `${label}\n`);

/** Run the real host CLI, as the surface the state store belongs to. */
function host(input: Buffer) {
  const [command, ...prefix] = JSON.parse(process.env.FAKE_HOST_CLI as string) as string[];
  return spawnSync(command, [...prefix, ...argv], {
    cwd: process.env.FAKE_STATE_CWD,
    env: { ...process.env, WORKFLOW_ID: '', ARCHON_NODE_EXECUTION: '' },
    input,
    encoding: 'utf8',
  });
}

if (argv[0] === 'state') {
  const put = argv[1] === 'put';
  const input = put ? readFileSync(0) : Buffer.alloc(0);
  if (put && existsSync(join(dir, 'put-fails'))) {
    process.stderr.write('state is read-only');
    process.exitCode = 1;
  } else {
    if (put && existsSync(join(dir, 'put-conflicts'))) host(input);
    const result = host(input);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.status ?? 1;
  }
} else if (argv[0] === 'forge' && argv[1] === 'resolve') {
  const match = /^https:\/\/([^/]+)\/(.+)\/pull\/([1-9][0-9]*)$/.exec(request.remote ?? '');
  done(
    'resolve',
    match === null
      ? { kind: 'none', forge: 'none' }
      : { kind: 'resolved', forge: 'fake', repo: { host: match[1], path: match[2] }, plugin: { name: 'fake', version: '1' }, subject: { kind: 'pr', number: Number(match[3]) } }
  );
} else if (argv[0] === 'forge' && argv[1] === 'pr.view') {
  const { repo, number } = (request.selector as NonNullable<Request['selector']>).ref;
  const pr = (JSON.parse(readFileSync(join(dir, 'prs.json'), 'utf8')) as Record<string, Reported>)[String(number)];
  done('pr.view', {
    pr: {
      schemaVersion: 1,
      repo,
      number,
      url: `https://${repo.host}/${repo.path}/pull/${number}`,
      head: pr.head,
      base: 'dev',
      is_draft: false,
      state: pr.state,
      head_repo: repo,
      head_revision: 'deadbeef',
      base_revision: 'cafe',
      maintainer_can_modify: null,
    },
    title: 'A change',
    body: '',
    timestamps: { created_at: pr.created, merged_at: pr.merged ?? null, closed_at: pr.closed ?? null },
  });
} else {
  process.stderr.write(`fake archon: unexpected command ${argv.join(' ')}`);
  process.exitCode = 1;
}
