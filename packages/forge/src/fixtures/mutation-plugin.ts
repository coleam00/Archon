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
  'workitem.create',
  'workitem.labels.set',
  'workitem.label.add',
  'workitem.comment.upsert',
  'workitem.close',
  'workitem.label.remove',
  'workitem.list',
  'repo.labels.list',
  'repo.label.ensure',
  'pr.view',
  'pr.create',
  'pr.edit-body',
  'pr.ready',
  'pr.draft',
  'comment.upsert',
  'pr.merge',
  'checks.rerun',
  'pr.reviews',
  'pr.threads',
  'pr.thread.reply',
  'pr.thread.resolve',
  'workitem.edit-body',
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
      mutationConditions: mode === 'no-conditions' ? undefined : { 'pr.merge': ['head'] },
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
    subject?: { kind: 'issue' | 'pr'; ref: PluginRef };
    label?: string;
    reason?: string;
    thread?: string;
    selector?: { kind: string; ref?: PluginRef };
    repo?: PluginRef['repo'];
    headRepo?: PluginRef['repo'];
    head?: string;
    headRevision?: string;
    base?: string;
    draft?: boolean;
    body?: string;
    marker?: string;
    title?: string;
    labels?: string[];
    name?: string;
    color?: string;
    description?: string;
    method?: 'merge' | 'squash';
    conditions?: { head?: string };
    revision?: string;
    units?: {
      unit: { kind: string; id: string; name: string };
      rerun: { id: string; attempt: number } | null;
    }[];
  };
  const ref = input.ref ??
    input.subject?.ref ??
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
    is_draft: input.op === 'pr.create' ? (input.draft ?? false) : input.op === 'pr.draft',
    state: mode === 'not-open' ? 'closed' : 'open',
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
    result: {
      op: input.op,
      value: { target, outcome: 'applied', changed: mode !== 'unchanged', ...value },
    },
  });

  const subject = {
    ref,
    kind: input.subject?.kind ?? 'issue',
    url: `https://forge.example/${repo.path}/issues/${String(ref.number)}`,
    state: 'open',
  };
  const listed = (items: unknown[]): unknown => ({
    operationId: input.operationId,
    ok: true,
    result: { op: input.op, value: { repo, label: input.label, items } },
  });

  /** An applied answer that does not answer the request it was sent. */
  const mismatched = (): unknown => {
    if (input.op === 'workitem.label.add') return answer(ref, { workitem: subject, labels: [] });
    if (input.op === 'workitem.label.remove')
      return answer(ref, { workitem: subject, labels: [input.name] });
    if (input.op === 'workitem.list') return listed([{ ...subject, state: 'closed' }]);
    if (input.op === 'pr.merge')
      return answer(ref, {
        ...mergeValue(),
        pr: { ...pr, state: 'merged', head_revision: 'wrong' },
      });
    if (input.op === 'checks.rerun')
      return answer(ref, { ref, revision: input.revision, units: input.units });
    if (input.op === 'pr.create')
      return answer(repo, { pr: { ...pr, head_revision: 'another-revision' } });
    if (input.op === 'pr.ready' || input.op === 'pr.draft')
      return answer(ref, { pr: { ...pr, is_draft: !pr.is_draft } });
    if (input.op === 'comment.upsert')
      return answer(ref, { comment: { ...comment, bodyDigest: digest('something else') } });
    if (input.op === 'workitem.comment.upsert')
      return answer(ref, {
        workitem: subject,
        comment: { ...comment, bodyDigest: digest('something else') },
      });
    if (input.op === 'workitem.close')
      return answer(ref, { workitem: { ...subject, state: 'closed' }, reason: 'not_planned' });
    if (input.op === 'pr.thread.reply')
      return answer(ref, {
        thread: input.thread,
        comment: { ...comment, bodyDigest: digest('something else') },
      });
    if (input.op === 'pr.thread.resolve')
      return answer(ref, { thread: 'another-thread', resolved: true });
    if (input.op === 'workitem.edit-body')
      return answer(ref, {
        workitem: { ...subject, kind: 'issue' },
        bodyDigest: digest('something else'),
      });
    return answer(ref, { pr, bodyDigest: digest('something else') });
  };

  const mergeValue = (): Record<string, unknown> => ({
    pr: { ...pr, state: 'merged', head_revision: input.conditions?.head },
    method: mode === 'wrong-method' ? 'merge' : input.method,
    conditions: mode === 'wrong-condition' ? { head: 'wrong' } : input.conditions,
    enforcedConditions: mode === 'unenforced' ? [] : ['head'],
    landed: { commit: 'landed', tree: 'tree', parents: ['base', 'head'] },
  });
  const applied = (): unknown => {
    if (input.op === 'workitem.create')
      return answer(repo, {
        changed: mode !== 'recovery',
        workitem: {
          ref: { repo, number: ref.number },
          kind: 'issue',
          url: `https://forge.example/${repo.path}/issues/${String(ref.number)}`,
          state: mode === 'recovery' ? 'closed' : 'open',
        },
        markerDigest: digest(input.marker ?? ''),
        titleDigest: digest(mode === 'recovery' ? 'edited' : (input.title ?? '')),
        bodyDigest: digest(mode === 'recovery' ? 'edited' : (input.body ?? '')),
      });
    if (input.op === 'workitem.labels.set')
      return answer(ref, {
        workitem: {
          ref,
          kind: 'issue',
          url: `https://forge.example/${repo.path}/issues/${String(ref.number)}`,
          state: 'open',
        },
        labels: input.labels,
      });
    if (input.op === 'workitem.label.add')
      return answer(ref, { workitem: subject, labels: ['other', input.name] });
    if (input.op === 'workitem.label.remove')
      return answer(ref, { workitem: subject, labels: ['other'] });
    if (input.op === 'workitem.list')
      return listed([subject, { ...subject, ref: { ...ref, number: ref.number + 1 }, kind: 'pr' }]);
    if (input.op === 'repo.label.ensure')
      return answer(repo, {
        label: {
          name: input.name,
          color: input.color,
          descriptionDigest: digest(input.description ?? ''),
        },
      });
    if (input.op === 'repo.labels.list')
      return {
        operationId: input.operationId,
        ok: true,
        result: { op: input.op, value: { repo, labels: [{ name: 'a' }] } },
      };
    if (input.op === 'pr.merge') return answer(ref, mergeValue());
    if (input.op === 'checks.rerun')
      return answer(ref, {
        ref,
        revision: input.revision,
        units: (mode === 'subset' ? input.units?.slice(0, 1) : input.units)?.map(selected => ({
          ...selected,
          rerun: selected.rerun ? { ...selected.rerun, attempt: selected.rerun.attempt + 1 } : null,
        })),
      });
    if (input.op === 'pr.reviews')
      return {
        operationId: input.operationId,
        ok: true,
        result: {
          op: input.op,
          value: {
            ref,
            items: [
              {
                kind: 'review_comment',
                id: '1',
                author: null,
                commit: 'head',
                state: null,
                createdAt: null,
                url: pr.url,
                body: 'private review body',
              },
            ],
          },
        },
      };
    if (input.op === 'pr.create') return answer(repo, { pr });
    if (input.op === 'pr.ready' || input.op === 'pr.draft') return answer(ref, { pr });
    if (input.op === 'comment.upsert') return answer(ref, { comment });
    if (input.op === 'workitem.comment.upsert') return answer(ref, { workitem: subject, comment });
    if (input.op === 'workitem.close')
      return answer(ref, { workitem: { ...subject, state: 'closed' }, reason: input.reason });
    if (input.op === 'pr.threads')
      return {
        operationId: input.operationId,
        ok: true,
        result: {
          op: input.op,
          value: {
            ref,
            threads: [
              {
                id: 'thread-1',
                resolved: false,
                outdated: false,
                path: 'src/a.ts',
                line: 3,
                comments: [{ id: 'c1', author: null, body: 'private thread body', url: pr.url }],
              },
            ],
          },
        },
      };
    if (input.op === 'pr.thread.reply') return answer(ref, { thread: input.thread, comment });
    if (input.op === 'pr.thread.resolve')
      return answer(ref, { thread: input.thread, resolved: true });
    if (input.op === 'workitem.edit-body')
      return answer(ref, {
        workitem: { ...subject, kind: 'issue' },
        bodyDigest: digest(input.body ?? ''),
      });
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
  } else if (mode === 'wrong-kind') {
    process.stdout.write(
      JSON.stringify(
        answer(ref, {
          workitem: { ...subject, kind: subject.kind === 'pr' ? 'issue' : 'pr' },
          ...(input.op === 'workitem.comment.upsert'
            ? { comment }
            : { labels: input.op === 'workitem.label.add' ? [input.name] : [] }),
        })
      )
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
        mutation: { op: input.op, target: input.repo ?? ref, outcome: 'refused' },
      })
    );
    process.exit(1);
  } else {
    process.stdout.write(JSON.stringify(applied()));
  }
}
