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
    repo?: PluginRef['repo'];
    headRepo?: PluginRef['repo'];
    head?: string;
    headRevision?: string;
    base?: string;
    draft?: boolean;
    body?: string;
  };
  const ref = input.ref ??
    input.selector?.ref ?? { repo: { host: 'forge.example', path: 'a/b' }, number: 1 };
  const repo = input.repo ?? ref.repo;
  // A create answers with the pull request the request asked for; every other
  // op answers with the one it named.
  const pr = {
    schemaVersion: 1,
    repo,
    number: ref.number,
    url: `https://forge.example/${repo.path}/pull/${String(ref.number)}`,
    head: input.head ?? 'feature',
    base: input.base ?? 'dev',
    is_draft: input.op === 'pr.create' ? (input.draft ?? false) : false,
    state: 'open',
    head_repo: input.headRepo ?? repo,
    head_revision: input.headRevision ?? 'headsha',
    base_revision: 'basesha',
    maintainer_can_modify: null,
  };
  const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
  const comment = {
    ref,
    id: '900',
    url: `https://forge.example/${repo.path}/pull/${String(ref.number)}#comment-900`,
    bodyDigest: digest(input.body ?? ''),
  };

  const answer = (target: unknown, value: object): unknown => ({
    operationId: input.operationId,
    ok: true,
    result: { op: input.op, value: { target, outcome: 'applied', changed: true, ...value } },
  });

  /** An applied answer that does not answer the request it was sent. */
  const mismatched = (): unknown => {
    if (input.op === 'pr.create')
      return answer(repo, { pr: { ...pr, head_revision: 'another-revision' } });
    if (input.op === 'pr.ready') return answer(ref, { pr: { ...pr, is_draft: true } });
    if (input.op === 'comment.upsert')
      return answer(ref, { comment: { ...comment, bodyDigest: digest('something else') } });
    return answer(ref, { pr, bodyDigest: digest('something else') });
  };

  const applied = (): unknown => {
    if (input.op === 'pr.create') return answer(repo, { pr });
    if (input.op === 'pr.ready') return answer(ref, { pr });
    if (input.op === 'comment.upsert') return answer(ref, { comment });
    return answer(ref, { pr, bodyDigest: digest(input.body ?? '') });
  };

  if (mode === 'view-content' || mode === 'closed') {
    process.stdout.write(
      JSON.stringify({
        operationId: input.operationId,
        ok: true,
        result: {
          op: 'pr.view',
          value: {
            pr: mode === 'closed' ? { ...pr, state: 'closed' } : pr,
            title: 'A secret title',
            body: 'A secret body',
          },
        },
      })
    );
  } else if (mode === 'wrong-target') {
    process.stdout.write(
      JSON.stringify(
        answer(ref, { pr: { ...pr, number: ref.number + 1 }, bodyDigest: digest(input.body ?? '') })
      )
    );
  } else if (mode === 'mismatch') {
    process.stdout.write(JSON.stringify(mismatched()));
  } else if (mode === 'registered-case') {
    // The forge answers in the case it has registered, whatever case was asked with.
    const registered = { host: repo.host.toUpperCase(), path: repo.path.toUpperCase() };
    process.stdout.write(
      JSON.stringify(answer(registered, { pr: { ...pr, repo: registered, head_repo: registered } }))
    );
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
    process.stdout.write(JSON.stringify(applied()));
  }
}
