/**
 * The fake forge the pack script runner installs in a script's process: a typed state
 * store behind `archon forge <op>`. It replaces `Bun.spawnSync` for that argv only and
 * keeps one pull request, one issue, the tracker's other issues and their comments, so a
 * write and the read that follows it see the same state. It records each write that
 * changed the store and answers every operation in the shape `ForgeOperations` declares,
 * so a change to a forge request or result fails to compile here.
 *
 * It holds no forge-plugin rules: it never refuses a write on its own. A test that needs
 * a refusal or a failed read-back scripts that operation's answer with `fail`.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import type { ForgeFailure, ForgeOperations } from 'archon:script';

type Op = keyof ForgeOperations;
type Request<O extends Op> = ForgeOperations[O]['request'];
type Result<O extends Op> = ForgeOperations[O]['result'];
type Repo = Request<'workitem.create'>['repo'];
type Target = Extract<NonNullable<ForgeFailure['mutation']>, { readonly outcome: 'verification_failed' }>['target'];
export type ForgePr = Result<'pr.create'>['pr'];
export type WriteOp = NonNullable<ForgeFailure['mutation']>['op'];

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

/** The starting state of the fake forge. */
export interface TrackerFake {
  readonly issueLabels?: readonly string[];
  readonly repositoryLabels?: readonly string[];
  /** The pull request every `pr.view` reports. */
  readonly pr?: TrackerPr;
  /** No pull request matches a head lookup until one is created. */
  readonly noOpenPr?: boolean;
  /** Existing comments, in listing order. */
  readonly comments?: readonly TrackerComment[];
  /** Every write answers that it did not read back, and changes nothing. */
  readonly writeLost?: boolean;
  /** Scripted failures: each named operation answers this, and changes nothing. */
  readonly fail?: { readonly [O in Op]?: ForgeFailure };
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

/** Where the fake records what a run did: argv, request bodies, and `<side>.<kind>` writes. */
export interface FakeForgeLogs {
  readonly forge: string;
  readonly requests: string;
  readonly side: string;
}

type Answer<O extends Op> = { readonly ok: true; readonly value: Result<O> } | ForgeFailure;
type Handlers<Ops extends Op> = { readonly [O in Ops]?: (request: Request<O>) => Answer<O> };

const DIGEST = 'sha256:fake';
const firstLine = (body: string): string => body.split(/\r?\n/, 1)[0] ?? '';
const issueUrl = (repo: Repo, n: number): string => `https://${repo.host}/${repo.path}/issues/${String(n)}`;
const author = (repo: Repo, login: string) => ({ host: repo.host, id: `user-${login}`, login });

/**
 * Install the fake forge in this process. Returns the live comment list, which a test's
 * own preload may read to answer an operation the fake does not.
 */
export function installFakeForge(fake: TrackerFake, logs: FakeForgeLogs): TrackerComment[] {
  const comments: { id: number; body: string; issue?: number; author?: string }[] = (fake.comments ?? []).map(row => ({ ...row }));
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
  const applied = (target: Target, changed = true) => ({ target, outcome: 'applied', changed }) as const;

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

  /** Store the comment on `onIssue` (the pull request when undefined) keyed by `marker`. */
  function upsert(repo: Repo, onIssue: number | undefined, marker: string, body: string) {
    let row = comments.find(each => each.issue === onIssue && firstLine(each.body) === marker);
    const changed = row?.body !== body;
    if (row === undefined) {
      row = { id: nextId++, body, ...(onIssue === undefined ? {} : { issue: onIssue }) };
      comments.push(row);
    } else row.body = body;
    if (changed) side('comments', { issue: onIssue ?? pr.number, body });
    return {
      changed,
      comment: { ref: { repo, number: onIssue ?? pr.number }, id: String(row.id), url: commentUrl(repo, row), bodyDigest: DIGEST },
    };
  }

  const reads: Handlers<Exclude<Op, WriteOp>> = {
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
      if (other === undefined) {
        return { operationId: 'op-workitem.view', ok: false, error: { kind: 'not_found', message: 'not found' } };
      }
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
  };

  const writes: Handlers<WriteOp> = {
    'repo.label.ensure': request => {
      labels.add(request.name);
      return done({ ...applied(request.repo), label: { name: request.name, color: request.color, descriptionDigest: DIGEST } });
    },
    'workitem.label.add': request => {
      issueLabels.push(request.name);
      return done({ ...applied(request.subject.ref), workitem: subjectSummary(request.subject.ref.repo), labels: [...issueLabels] });
    },
    'workitem.label.remove': request => {
      issueLabels = issueLabels.filter(name => name !== request.name);
      return done({ ...applied(request.subject.ref), workitem: subjectSummary(request.subject.ref.repo), labels: [...issueLabels] });
    },
    // Issues are keyed by their marker, the contract's create-or-recover key.
    'workitem.create': request => {
      const found = issues.find(row => !row.pull && firstLine(row.body) === request.marker);
      const number = found?.number ?? 100 + issues.length;
      if (found === undefined) {
        issues.push({ number, title: request.title, body: request.body, state: 'OPEN' });
        side('issues', issues[issues.length - 1]);
      }
      return done({
        ...applied(request.repo, found === undefined),
        workitem: { kind: 'issue', ref: { repo: request.repo, number }, url: issueUrl(request.repo, number), state: 'open' },
        markerDigest: DIGEST,
        titleDigest: DIGEST,
        bodyDigest: DIGEST,
      });
    },
    'workitem.close': request => {
      const changed = subject.state !== 'closed' || subject.state_reason !== request.reason;
      subject.state = 'closed';
      subject.state_reason = request.reason;
      if (changed) side('closes', { number: subject.number, state: 'closed', state_reason: request.reason });
      return done({ ...applied(request.ref, changed), workitem: { ...subjectSummary(request.ref.repo), state: 'closed' }, reason: request.reason });
    },
    'workitem.edit-body': request => {
      side('bodies', request.body);
      subject.body = request.body;
      return done({ ...applied(request.ref), workitem: subjectSummary(request.ref.repo), bodyDigest: DIGEST });
    },
    'workitem.comment.upsert': request => {
      const { ref } = request.subject;
      const onIssue = request.subject.kind === 'pr' ? undefined : ref.number;
      const { changed, comment } = upsert(ref.repo, onIssue, request.marker, request.body);
      const workitem =
        onIssue === undefined
          ? ({ ref, kind: 'pr', url: record(ref.repo).url, state: 'open' } as const)
          : ({ ref, kind: 'issue', url: issueUrl(ref.repo, ref.number), state: 'open' } as const);
      return done({ ...applied(ref, changed), workitem, comment });
    },
    'comment.upsert': request => {
      const { changed, comment } = upsert(request.ref.repo, undefined, request.marker, request.body);
      return done({ ...applied(request.ref, changed), comment });
    },
    'pr.create': request => {
      Object.assign(pr, {
        isDraft: request.draft,
        title: request.title,
        body: request.body,
        headRefName: request.head,
        headRefOid: request.headRevision,
        baseRefName: request.base,
        state: 'OPEN',
      });
      exists = true;
      return done({ ...applied(request.repo), pr: record(request.repo) });
    },
    'pr.edit-body': request => {
      side('bodies', request.body);
      pr.body = request.body;
      return done({ ...applied(request.ref), pr: record(request.ref.repo), bodyDigest: DIGEST });
    },
    'pr.ready': request => {
      pr.isDraft = false;
      return done({ ...applied(request.ref), pr: record(request.ref.repo) });
    },
    'pr.draft': request => {
      pr.isDraft = true;
      return done({ ...applied(request.ref), pr: record(request.ref.repo) });
    },
  };

  /** What a write answers under `writeLost`: the forge could not read it back. */
  const lost = (op: string): ForgeFailure => ({
    operationId: `op-${op}`,
    ok: false,
    error: { kind: 'forge_error', message: 'the write did not read back' },
    mutation: {
      op: op as WriteOp,
      target: { host: 'unknown', path: 'unknown' },
      outcome: 'verification_failed',
      leaveBehind: 'nothing',
    },
  });
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
    type Untyped = Readonly<Record<string, ((request: unknown) => Answer<Op>) | undefined>>;
    const write = (writes as Untyped)[op];
    const handler = write ?? (reads as Untyped)[op];
    const scripted = (fake.fail as Readonly<Record<string, ForgeFailure | undefined>> | undefined)?.[op];
    const answer: Answer<Op> =
      scripted ??
      (fake.writeLost && write ? lost(op) : undefined) ??
      handler?.(JSON.parse(raw)) ?? {
        operationId: `op-${op}`,
        ok: false,
        error: { kind: 'unsupported_op', message: `the fake forge has no ${op}` },
      };
    const response = answer.ok ? { operationId: `op-${op}`, ok: true, result: { op, value: answer.value } } : answer;
    return { exitCode: answer.ok ? 0 : 1, stdout: Buffer.from(JSON.stringify(response)), stderr: Buffer.from('') };
  };
  Object.defineProperty(Bun, 'spawnSync', { value: fakeSpawn });
  return comments;
}
