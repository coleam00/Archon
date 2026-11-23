/**
 * The stateful fake forge the pack script runner installs in a script's process. It
 * replaces `Bun.spawnSync` for `archon forge <op>` argv only and keeps one mutable pull
 * request, one issue, the tracker's other issues and their comments, so a write and the
 * read-back that follows it see the same state.
 *
 * Every answer is typed by the forge contract's own `ForgeOperations`, so a change to a
 * request or result shape fails to compile here instead of passing the pack tests while
 * the real forge answers differently.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import type { ForgeFailure, ForgeOperations } from 'archon:script';

type Op = keyof ForgeOperations;
type Request<O extends Op> = ForgeOperations[O]['request'];
type Result<O extends Op> = ForgeOperations[O]['result'];
type Repo = Request<'workitem.create'>['repo'];
export type ForgePr = Result<'pr.create'>['pr'];

/** One conversation comment on the tracker. */
export interface TrackerComment {
  readonly id: number;
  readonly body: string;
  /** The issue it is on; omitted for the pull request. */
  readonly issue?: number;
  /** The author's login; omitted reports no author. */
  readonly author?: string;
}

/** The pull request the fake forge reports, before any write in the run. */
export interface TrackerPr {
  readonly title?: string;
  readonly body?: string;
  readonly isDraft?: boolean;
  readonly state?: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly headRefName?: string;
  readonly headRefOid?: string;
  readonly baseRefName?: string;
  /** The head repository's owner; omitted, the head is in the pull request's repository. */
  readonly headRepositoryOwner?: { readonly login: string };
}

/** The starting state of the stateful fake forge. */
export interface TrackerFake {
  readonly issueLabels?: readonly string[];
  readonly repositoryLabels?: readonly string[];
  /** The pull request every `pr.view` reports. */
  readonly pr?: TrackerPr;
  /** No pull request matches a head lookup until one is created. */
  readonly noOpenPr?: boolean;
  /** Existing comments, in listing order. */
  readonly comments?: readonly TrackerComment[];
  /** Drop every write instead of applying it, so the plugin's read-back disagrees. */
  readonly writeLost?: boolean;
  /** Existing tracker issues; `workitem.create` appends to them. */
  readonly issues?: readonly TrackerIssue[];
  /** The issue the run is about; number 7 by default. Labels come from `issueLabels`. */
  readonly issue?: TrackerSubject;
}

/** The issue the run is about. */
export interface TrackerSubject {
  readonly number?: number;
  readonly title?: string;
  readonly body?: string;
  /** The author's login; null for a deleted account. */
  readonly author?: string | null;
  readonly state?: 'open' | 'closed';
  /** Why a closed issue was closed. */
  readonly state_reason?: Request<'workitem.close'>['reason'];
}

/** One other issue the fake forge knows. */
export interface TrackerIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'OPEN' | 'CLOSED';
  /** A pull request, which shares the issue numbering. */
  readonly pull?: boolean;
}

/** Where the fake records what a run did: argv, request bodies, and `<side>.<kind>` side effects. */
export interface FakeForgeLogs {
  readonly forge: string;
  readonly requests: string;
  readonly side: string;
}

type Mutation = NonNullable<ForgeFailure['mutation']>;
type Target = Extract<Mutation, { readonly outcome: 'verification_failed' }>['target'];

/** A result, or a refusal; a refused or unverified write names its target, as the forge's does. */
type Answer<O extends Op> =
  | { readonly ok: true; readonly value: Result<O> }
  | {
      readonly ok: false;
      readonly message: string;
      readonly mutation?:
        | { readonly target: Target; readonly outcome: 'refused' }
        | { readonly target: Target; readonly outcome: 'verification_failed'; readonly leaveBehind: string };
    };

type Handlers = { readonly [O in Op]?: (request: Request<O>) => Answer<O> };

const DIGEST = 'sha256:fake';
const firstLine = (body: string): string => body.split(/\r?\n/, 1)[0] ?? '';
const issueUrl = (repo: Repo, n: number): string => `https://${repo.host}/${repo.path}/issues/${String(n)}`;
const author = (repo: Repo, login: string) => ({ host: repo.host, id: `user-${login}`, login });

/**
 * Install the fake forge in this process. Returns the live comment list, which a test's
 * own preload may read to answer an operation the fake does not.
 */
export function installFakeForge(fake: TrackerFake, logs: FakeForgeLogs): { body: string; id: number; issue?: number; author?: string }[] {
  const comments = (fake.comments ?? []).map(row => ({ ...row }));
  const pr = {
    number: 42,
    title: 'A title',
    body: 'A body',
    isDraft: true,
    state: 'OPEN' as NonNullable<TrackerPr['state']>,
    headRefName: 'feature',
    headRefOid: 'deadbeef',
    baseRefName: 'dev',
    headRepositoryOwner: undefined as TrackerPr['headRepositoryOwner'],
    ...fake.pr,
  };
  const subject = {
    number: 7,
    title: 'An issue',
    body: 'An issue body',
    author: 'someone' as string | null,
    state: 'open' as 'open' | 'closed',
    state_reason: undefined as TrackerSubject['state_reason'],
    ...fake.issue,
  };
  const issues = (fake.issues ?? []).map(row => ({ ...row }));
  let exists = fake.noOpenPr !== true;
  let nextId = 900;
  const labels = new Set(fake.repositoryLabels ?? ['operator', 'archon-blocked', 'area']);
  let issueLabels = [...(fake.issueLabels ?? ['operator', 'archon-blocked'])];
  const side = (kind: string, value: unknown): void => appendFileSync(`${logs.side}.${kind}`, `${JSON.stringify(value)}\n`);
  const done = <O extends Op>(value: Result<O>): Answer<O> => ({ ok: true, value });
  /** A refused read when `target` is omitted, else a refused write on it. */
  const refused = <O extends Op>(message: string, target?: Target): Answer<O> => ({
    ok: false,
    message,
    ...(target === undefined ? {} : { mutation: { target, outcome: 'refused' } }),
  });
  /** Apply a write on `target` and answer with its read-back, or report the read-back failed under `writeLost`. */
  const write = <O extends Op>(target: Target, apply: () => void, value: () => Result<O>): Answer<O> => {
    if (fake.writeLost) {
      return { ok: false, message: 'the write did not read back', mutation: { target, outcome: 'verification_failed', leaveBehind: 'nothing: the fake dropped the write' } };
    }
    apply();
    return done(value());
  };
  const applied = (target: Target) => ({ target, outcome: 'applied', changed: true }) as const;

  function record(repo: Repo): ForgePr {
    const owner = pr.headRepositoryOwner?.login;
    return {
      schemaVersion: 1,
      repo,
      number: pr.number,
      url: `https://${repo.host}/${repo.path}/pull/${String(pr.number)}`,
      head: pr.headRefName,
      base: pr.baseRefName,
      is_draft: pr.isDraft,
      state: pr.state === 'OPEN' ? 'open' : pr.state === 'CLOSED' ? 'closed' : 'merged',
      head_repo: owner === undefined ? repo : { host: repo.host, path: `${owner}/${repo.path.split('/')[1] ?? ''}` },
      head_revision: pr.headRefOid,
      base_revision: null,
      maintainer_can_modify: null,
    };
  }
  const subjectSummary = (repo: Repo) =>
    ({ ref: { repo, number: subject.number }, kind: 'issue', url: issueUrl(repo, subject.number), state: subject.state }) as const;
  const commentUrl = (repo: Repo, row: { id: number; issue?: number }): string => {
    const item = row.issue === undefined ? `/pull/${String(pr.number)}` : `/issues/${String(row.issue)}`;
    return `https://${repo.host}/${repo.path}${item}#issuecomment-${String(row.id)}`;
  };

  /** Write the one comment on `onIssue` (the pull request when undefined) that begins with `marker`. */
  function upsert(repo: Repo, onIssue: number | undefined, marker: string, body: string) {
    type Upserted = { readonly ok: false; readonly message: string } | { readonly ok: true; readonly changed: boolean; readonly apply: () => void; readonly comment: () => Result<'comment.upsert'>['comment'] };
    if (firstLine(body) !== marker) return { ok: false, message: 'the body must begin with its marker' } as Upserted;
    const marked = comments.filter(row => row.issue === onIssue && firstLine(row.body) === marker);
    if (marked.length > 1) return { ok: false, message: 'more than one comment carries the marker' } as Upserted;
    let row = marked[0];
    const comment = () => {
      if (row === undefined) throw new Error('the fake forge wrote no comment');
      return { ref: { repo, number: onIssue ?? pr.number }, id: String(row.id), url: commentUrl(repo, row), bodyDigest: DIGEST };
    };
    if (row !== undefined && row.body === body) return { ok: true, changed: false, apply: () => {}, comment } as Upserted;
    const apply = (): void => {
      if (row !== undefined) row.body = body;
      else {
        row = { id: nextId++, body, ...(onIssue === undefined ? {} : { issue: onIssue }) };
        comments.push(row);
      }
      side('comments', { issue: onIssue ?? pr.number, body });
    };
    return { ok: true, changed: true, apply, comment } as Upserted;
  }

  const handlers: Handlers = {
    'workitem.view': ({ ref }) => {
      if (ref.number === subject.number) {
        return done({
          ref,
          kind: 'issue',
          title: subject.title,
          body: subject.body,
          state: subject.state,
          url: issueUrl(ref.repo, subject.number),
          labels: [...new Set(issueLabels)],
          ...(subject.author === undefined ? {} : { author: subject.author === null ? null : author(ref.repo, subject.author) }),
        });
      }
      const other = issues.find(row => row.number === ref.number);
      if (other === undefined) return refused('not found');
      const url = issueUrl(ref.repo, other.number);
      return done({
        ref,
        kind: other.pull ? 'pr' : 'issue',
        title: other.title,
        body: other.body,
        state: other.state === 'OPEN' ? 'open' : 'closed',
        url: other.pull ? url.replace('/issues/', '/pull/') : url,
        labels: [],
        author: author(ref.repo, 'someone'),
      });
    },
    resolve: request => {
      const web = request.web ? /^(.+)\/(issues|pull)\/([1-9][0-9]*)$/.exec(request.remote ?? '') : null;
      const url = request.web && web === null ? null : /^https:\/\/([^/]+)\/(.+?)(?:\.git)?$/.exec(web?.[1] ?? request.remote ?? '');
      if (url === null) return done({ kind: 'none', forge: 'none' });
      return done({
        kind: 'resolved',
        forge: 'fake',
        repo: { host: url[1] ?? '', path: url[2] ?? '' },
        plugin: { name: 'fake', version: '1' },
        ...(web ? { subject: { kind: web[2] === 'pull' ? 'pr' : 'issue', number: Number(web[3]) } } : {}),
      });
    },
    'repo.labels.list': ({ repo }) => done({ repo, labels: [...labels].map(name => ({ name })) }),
    'repo.label.ensure': request =>
      write(
        request.repo,
        () => labels.add(request.name),
        () => ({ ...applied(request.repo), label: { name: request.name, color: request.color, descriptionDigest: DIGEST } })
      ),
    'workitem.label.add': request =>
      write(
        request.subject.ref,
        () => issueLabels.push(request.name),
        () => ({ ...applied(request.subject.ref), workitem: subjectSummary(request.subject.ref.repo), labels: [...issueLabels] })
      ),
    'workitem.label.remove': request =>
      write(
        request.subject.ref,
        () => {
          issueLabels = issueLabels.filter(name => name !== request.name);
        },
        () => ({ ...applied(request.subject.ref), workitem: subjectSummary(request.subject.ref.repo), labels: [...issueLabels] })
      ),
    'workitem.create': request => {
      const created = (number: number) =>
        ({ kind: 'issue', ref: { repo: request.repo, number }, url: issueUrl(request.repo, number), state: 'open' }) as const;
      const digests = { markerDigest: DIGEST, titleDigest: DIGEST, bodyDigest: DIGEST };
      const marked = issues.filter(row => !row.pull && firstLine(row.body) === request.marker);
      if (marked.length > 1) return refused('more than one issue carries the marker', request.repo);
      const found = marked[0];
      if (found !== undefined) {
        return done({ ...applied(request.repo), changed: false, workitem: created(found.number), ...digests });
      }
      const number = 100 + issues.length;
      return write(
        request.repo,
        () => {
          issues.push({ number, title: request.title, body: request.body, state: 'OPEN' });
          side('issues', issues[issues.length - 1]);
        },
        () => ({ ...applied(request.repo), workitem: created(number), ...digests })
      );
    },
    'workitem.close': request => {
      const closed = () => ({ ...subjectSummary(request.ref.repo), state: 'closed' }) as const;
      if (subject.state === 'closed') {
        return subject.state_reason === request.reason
          ? done({ ...applied(request.ref), changed: false, workitem: closed(), reason: request.reason })
          : refused('the issue is already closed for another reason', request.ref);
      }
      return write(
        request.ref,
        () => {
          side('closes', { number: subject.number, state: 'closed', state_reason: request.reason });
          subject.state = 'closed';
          subject.state_reason = request.reason;
        },
        () => ({ ...applied(request.ref), workitem: closed(), reason: request.reason })
      );
    },
    'workitem.edit-body': request =>
      write(
        request.ref,
        () => {
          side('bodies', request.body);
          subject.body = request.body;
        },
        () => ({ ...applied(request.ref), workitem: subjectSummary(request.ref.repo), bodyDigest: DIGEST })
      ),
    'workitem.comment.upsert': request => {
      const { ref } = request.subject;
      const onIssue = request.subject.kind === 'pr' ? undefined : ref.number;
      const upserted = upsert(ref.repo, onIssue, request.marker, request.body);
      if (!upserted.ok) return refused(upserted.message, ref);
      const workitem =
        onIssue === undefined
          ? ({ ref, kind: 'pr', url: record(ref.repo).url, state: 'open' } as const)
          : ({ ref, kind: 'issue', url: issueUrl(ref.repo, ref.number), state: 'open' } as const);
      const value = () => ({ ...applied(ref), changed: upserted.changed, workitem, comment: upserted.comment() });
      return upserted.changed ? write(ref, upserted.apply, value) : done(value());
    },
    'comment.upsert': request => {
      const upserted = upsert(request.ref.repo, undefined, request.marker, request.body);
      if (!upserted.ok) return refused(upserted.message, request.ref);
      const value = () => ({ ...applied(request.ref), changed: upserted.changed, comment: upserted.comment() });
      return upserted.changed ? write(request.ref, upserted.apply, value) : done(value());
    },
    'workitem.comments': request => {
      const { ref } = request.subject;
      const onIssue = request.subject.kind === 'pr' ? undefined : ref.number;
      return done({
        workitem: { ref, kind: request.subject.kind, url: issueUrl(ref.repo, ref.number), state: 'open' },
        comments: comments
          .filter(row => row.issue === onIssue)
          .map(row => ({
            id: String(row.id),
            url: commentUrl(ref.repo, row),
            body: row.body,
            author: row.author === undefined ? null : author(ref.repo, row.author),
          })),
      });
    },
    'pr.view': ({ selector }) => {
      if (selector.kind === 'head') {
        const found = exists && (selector.state === 'any' || pr.state === 'OPEN') && pr.headRefName === selector.head;
        return done(found ? { pr: record(selector.repo), title: pr.title, body: pr.body } : null);
      }
      return done({ pr: record(selector.ref.repo), title: pr.title, body: pr.body });
    },
    'pr.create': request =>
      write(
        request.repo,
        () => {
          pr.isDraft = request.draft;
          pr.title = request.title;
          pr.body = request.body;
          pr.headRefName = request.head;
          pr.headRefOid = request.headRevision;
          pr.baseRefName = request.base;
          pr.state = 'OPEN';
          exists = true;
        },
        () => ({ ...applied(request.repo), pr: record(request.repo) })
      ),
    'pr.edit-body': request =>
      write(
        request.ref,
        () => {
          side('bodies', request.body);
          pr.body = request.body;
        },
        () => ({ ...applied(request.ref), pr: record(request.ref.repo), bodyDigest: DIGEST })
      ),
    'pr.ready': request =>
      write(
        request.ref,
        () => {
          pr.isDraft = false;
        },
        () => ({ ...applied(request.ref), pr: record(request.ref.repo) })
      ),
    'pr.draft': request =>
      write(
        request.ref,
        () => {
          pr.isDraft = true;
        },
        () => ({ ...applied(request.ref), pr: record(request.ref.repo) })
      ),
  };

  const original = Bun.spawnSync.bind(Bun);
  const fakeSpawn = (argv: string[], settings?: unknown) => {
    const command = JSON.parse(process.env.ARCHON_CLI_COMMAND || '[]') as string[];
    const forgeCall =
      command.length > 0 && command.every((part, index) => argv[index] === part) && argv[command.length] === 'forge';
    if (!forgeCall) return (original as (argv: string[], settings?: unknown) => unknown)(argv, settings);
    const rest = argv.slice(command.length);
    appendFileSync(logs.forge, `${rest.join(' ')}\n`);
    const op = rest[1] ?? '';
    const dataFile = rest.indexOf('--data-file');
    const raw = dataFile >= 0 ? readFileSync(rest[dataFile + 1] ?? '', 'utf8') : (rest[rest.indexOf('--data') + 1] ?? '');
    if (dataFile >= 0) appendFileSync(logs.requests, `${raw}\n`);
    // The op comes from argv, so the request is typed only once its handler is chosen.
    const handler = (handlers as Readonly<Record<string, ((request: unknown) => Answer<Op>) | undefined>>)[op];
    const answer: Answer<Op> = handler ? handler(JSON.parse(raw)) : refused(`the fake forge has no ${op}`);
    const response = answer.ok
      ? { operationId: `op-${op}`, ok: true, result: { op, value: answer.value } }
      : ({
          operationId: `op-${op}`,
          ok: false,
          error: { kind: 'forge_error', message: answer.message },
          // A mutation names a write op; only a handler for one passes a target.
          ...(answer.mutation === undefined ? {} : { mutation: { op: op as Mutation['op'], ...answer.mutation } }),
        } satisfies ForgeFailure);
    return { exitCode: answer.ok ? 0 : 1, stdout: Buffer.from(JSON.stringify(response)), stderr: Buffer.from('') };
  };
  Object.defineProperty(Bun, 'spawnSync', { value: fakeSpawn });
  return comments;
}
