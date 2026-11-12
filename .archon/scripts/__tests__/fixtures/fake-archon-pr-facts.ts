/**
 * The host CLI for the pull-request facts test: the commands `readPrFacts` runs, answered
 * from `$FAKE_DIR`. `state list` and `state put` keep documents in `state.json` with the
 * revision rule the real store has (`--if-revision 0` creates; a stale revision exits 3 and
 * names `revision_moved`, as does the presence of `put-conflicts`, a write another run won);
 * `forge resolve` reads a pull request URL; `forge pr.view` answers from `prs.json`, a map
 * of pull request number to what the forge reports. Every call's argv is appended to
 * `calls.log`, a `forge pr.view` with its pull request number. A `state put` fails (exit 1)
 * when `put-fails` exists.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_DIR as string;
const argv = process.argv.slice(2);
const read = <T>(file: string, fallback: T): T =>
  existsSync(join(dir, file)) ? (JSON.parse(readFileSync(join(dir, file), 'utf8')) as T) : fallback;
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

const documents = read<Record<string, { revision: number; value: unknown }>>('state.json', {});
if (argv[0] === 'state' && argv[1] === 'list') {
  const prefix = argv[argv.indexOf('--prefix') + 1];
  out({ documents: Object.entries(documents).filter(([name]) => name.startsWith(prefix)).map(([name, row]) => ({ name, ...row })) });
} else if (argv[0] === 'state' && argv[1] === 'put') {
  const name = argv[2];
  const ifRevision = Number(argv[argv.indexOf('--if-revision') + 1]);
  if (existsSync(join(dir, 'put-fails'))) {
    process.stderr.write('state is read-only');
    process.exitCode = 1;
  } else if (existsSync(join(dir, 'put-conflicts')) || (documents[name]?.revision ?? 0) !== ifRevision) {
    out({ reason: 'revision_moved' });
    process.exitCode = 3;
  }
  else {
    documents[name] = { revision: ifRevision + 1, value: JSON.parse(readFileSync(0, 'utf8')) };
    writeFileSync(join(dir, 'state.json'), JSON.stringify(documents));
    out({ ok: true });
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
  const pr = read<Record<string, Reported>>('prs.json', {})[String(number)];
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
