import { createHash } from 'node:crypto';

interface PluginRef {
  repo: { host: string; path: string };
  number: number;
}

const args = process.argv.slice(2);
export {};
const modeAt = args.indexOf('--mode');
const mode = modeAt >= 0 ? args[modeAt + 1] : 'ok';
const command = args.find(value => value === 'metadata' || value === 'op');

const OPS = [
  'resolve',
  'checks.state',
  'workitem.view',
  'pr.view',
  'pr.create',
  'pr.edit-body',
  'pr.ready',
  'comment.upsert',
];

if (command === 'metadata') {
  process.stdout.write(
    JSON.stringify({
      protocol: 1,
      name: 'mutator',
      version: '1.0.0',
      forge: 'test',
      hosts: ['forge.example'],
      capabilities: OPS,
      token_env: [],
    })
  );
  process.exit(0);
}

if (mode === 'hang') setInterval(Date.now, 1_000);
else {
  const input = (await Bun.stdin.json()) as {
    operationId: string;
    op: string;
    ref?: PluginRef;
    selector?: { kind: string; ref?: PluginRef };
    body?: string;
  };
  const ref = input.ref ??
    input.selector?.ref ?? { repo: { host: 'forge.example', path: 'a/b' }, number: 1 };
  const pr = {
    schemaVersion: 1,
    repo: ref.repo,
    number: ref.number,
    url: `https://forge.example/${ref.repo.path}/pull/${String(ref.number)}`,
    head: 'feature',
    base: 'dev',
    is_draft: false,
    state: 'open',
    head_repo: ref.repo,
    head_revision: 'headsha',
    base_revision: 'basesha',
    maintainer_can_modify: null,
  };
  const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

  const applied = (value: object): unknown => ({
    operationId: input.operationId,
    ok: true,
    result: { op: input.op, value: { target: ref, outcome: 'applied', changed: true, ...value } },
  });

  if (mode === 'view-content') {
    process.stdout.write(
      JSON.stringify({
        operationId: input.operationId,
        ok: true,
        result: {
          op: 'pr.view',
          value: { pr, title: 'A secret title', body: 'A secret body' },
        },
      })
    );
  } else if (mode === 'wrong-target') {
    process.stdout.write(
      JSON.stringify(
        applied({ pr: { ...pr, number: ref.number + 1 }, bodyDigest: digest(input.body ?? '') })
      )
    );
  } else if (mode === 'wrong-digest') {
    process.stdout.write(JSON.stringify(applied({ pr, bodyDigest: digest('something else') })));
  } else if (mode === 'no-evidence') {
    process.stdout.write(
      JSON.stringify({
        operationId: input.operationId,
        ok: false,
        error: { kind: 'forge_error', message: 'it did not work' },
      })
    );
    process.exit(1);
  } else if (mode === 'refused') {
    process.stdout.write(
      JSON.stringify({
        operationId: input.operationId,
        ok: false,
        error: { kind: 'conflict', message: 'the forge said no' },
        mutation: { op: input.op, target: ref, outcome: 'refused' },
      })
    );
    process.exit(1);
  } else {
    process.stdout.write(JSON.stringify(applied({ pr, bodyDigest: digest(input.body ?? '') })));
  }
}
