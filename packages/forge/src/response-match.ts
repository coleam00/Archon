import {
  contentDigest,
  isMutationRequest,
  mergeConditionSchema,
  mutationTarget,
  type ForgeMutationFailure,
  type ForgeMutationRequest,
  type ForgeMutationTarget,
  type ForgeRequest,
  type ForgeResponse,
  type PluginMetadata,
  type SelectedCheck,
} from './operations';
import type { ForgeSubjectRef, PrRef, RepoRef } from './identity';
import { normalizeHost } from './plugin-config';
import { parseRemoteUrl } from './remote-url';

type ForgeOp = ForgeRequest['op'];
type OpRequest<Op extends ForgeOp> = Extract<ForgeRequest, { op: Op }>;
type ForgeResult = Extract<ForgeResponse, { ok: true }>['result'];
type OpValue<Op extends ForgeOp> = Extract<ForgeResult, { op: Op }>['value'];
interface MatchContext {
  metadata: PluginMetadata;
  host: string;
}
type ResultMatcher<Op extends ForgeOp> = (
  request: OpRequest<Op>,
  value: OpValue<Op>,
  context: MatchContext
) => boolean;

type MutationOp = ForgeMutationRequest['op'];
type SubjectRecord = NonNullable<Extract<ForgeMutationFailure, { outcome: 'refused' }>['workitem']>;
type WorkitemEvidenceMatcher<Op extends MutationOp> = (
  request: OpRequest<Op>,
  workitem: SubjectRecord
) => boolean;

/**
 * Repository identity, compared the way a forge registers it.
 *
 * Host and owner/name are case-insensitive but case-preserving: a forge echoes
 * back the case it has registered, whatever case the request carried. An exact
 * comparison would read a write that landed exactly as asked as one that did not.
 */
function sameRepo(left: RepoRef, right: RepoRef): boolean {
  return (
    normalizeHost(left.host) === normalizeHost(right.host) &&
    left.path.toLowerCase() === right.path.toLowerCase()
  );
}
function sameRef(left: PrRef, right: PrRef): boolean {
  return sameRepo(left.repo, right.repo) && left.number === right.number;
}
function sameSubject(
  observed: { ref: PrRef; kind: ForgeSubjectRef['kind'] },
  subject: ForgeSubjectRef
): boolean {
  return observed.kind === subject.kind && sameRef(observed.ref, subject.ref);
}
function sameTarget(left: ForgeMutationTarget, right: ForgeMutationTarget): boolean {
  return 'repo' in left
    ? 'repo' in right && sameRef(left, right)
    : !('repo' in right) && sameRepo(left, right);
}

function sameCheck(left: SelectedCheck, right: SelectedCheck): boolean {
  return (
    left.unit.kind === right.unit.kind &&
    left.unit.id === right.unit.id &&
    left.unit.name === right.unit.name
  );
}
function newerAttempt(observed: SelectedCheck, selected: SelectedCheck): boolean {
  return (
    sameCheck(observed, selected) &&
    observed.rerun !== null &&
    selected.rerun !== null &&
    observed.rerun.id === selected.rerun.id &&
    observed.rerun.attempt > selected.rerun.attempt
  );
}

function matchesResolvedHost(request: ForgeRequest, observed: string, host: string): boolean {
  // Released resolvers normalize HTTPS :443 through WHATWG URL.host.
  return (
    normalizeHost(observed) === host || normalizeHost(observed) === httpsDefaultPortHost(request)
  );
}

/** The bare host an HTTPS remote on the default port names, or undefined for any other remote. */
export function httpsDefaultPortHost(request: ForgeRequest): string | undefined {
  if (request.op !== 'resolve' || !request.remote) return undefined;
  try {
    const { url, host } = parseRemoteUrl(request.remote.trim());
    // HTTPS :443 used to select bare-host claims before explicit ports were preserved.
    if (url.protocol === 'https:' && host === `${url.hostname}:443`) {
      return normalizeHost(url.hostname);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function matchesMergeEvidence(
  request: OpRequest<'pr.merge'>,
  evidence: ForgeMutationFailure
): boolean {
  return (
    evidence.merge?.method === request.method &&
    mergeConditionSchema.options.every(
      key => evidence.merge?.conditions[key] === request.conditions[key]
    )
  );
}

function matchesRerunEvidence(
  request: OpRequest<'checks.rerun'>,
  evidence: ForgeMutationFailure
): boolean {
  return (
    evidence.rerun?.revision === request.revision &&
    evidence.rerun.requested.length === request.units.length &&
    evidence.rerun.requested.every(
      (selected, index) =>
        sameCheck(selected, request.units[index]) &&
        selected.rerun?.id === request.units[index].rerun?.id &&
        selected.rerun?.attempt === request.units[index].rerun?.attempt
    ) &&
    evidence.rerun.observed.every(observed =>
      request.units.some(selected => newerAttempt(observed, selected))
    )
  );
}

/** Evidence of the attempt itself, carried only by the operations that record one. */
function matchesAttemptEvidence(
  request: ForgeMutationRequest,
  evidence: ForgeMutationFailure
): boolean {
  if (request.op === 'pr.merge') return matchesMergeEvidence(request, evidence);
  if (request.op === 'checks.rerun') return matchesRerunEvidence(request, evidence);
  return true;
}

function matchesObservedEvidence(
  request: ForgeMutationRequest,
  evidence: ForgeMutationFailure
): boolean {
  if (!('observed' in evidence) || !evidence.observed) return true;
  return 'repo' in request
    ? sameRepo(evidence.observed.repo, request.repo)
    : sameRef(evidence.observed, 'subject' in request ? request.subject.ref : request.ref);
}

function issueByRef(request: { ref: PrRef }, workitem: SubjectRecord): boolean {
  return workitem.kind === 'issue' && sameRef(workitem.ref, request.ref);
}
function bySubject(request: { subject: ForgeSubjectRef }, workitem: SubjectRecord): boolean {
  return sameSubject(workitem, request.subject);
}

/** The operations whose failure may name a work item; any other operation's work item is foreign. */
const workitemEvidenceMatchers: { [Op in MutationOp]?: WorkitemEvidenceMatcher<Op> } = {
  'workitem.create': (request, workitem) =>
    workitem.kind === 'issue' && sameRepo(workitem.ref.repo, request.repo),
  'workitem.labels.set': issueByRef,
  'workitem.close': issueByRef,
  'workitem.edit-body': issueByRef,
  'workitem.label.add': bySubject,
  'workitem.label.remove': bySubject,
  'workitem.comment.upsert': bySubject,
};

function matchesWorkitemEvidence(
  request: ForgeMutationRequest,
  evidence: ForgeMutationFailure
): boolean {
  if (!('workitem' in evidence) || !evidence.workitem) return true;
  // Keyed by the request's own op, the matcher takes that request; TypeScript cannot
  // correlate the table's members with the request union on its own.
  const matcher = workitemEvidenceMatchers[request.op] as
    | WorkitemEvidenceMatcher<MutationOp>
    | undefined;
  return matcher !== undefined && matcher(request, evidence.workitem);
}

function matchesLabelEvidence(
  request: ForgeMutationRequest,
  evidence: ForgeMutationFailure
): boolean {
  if (!('label' in evidence) || !evidence.label) return true;
  return request.op === 'repo.label.ensure' && evidence.label.name === request.name;
}

/**
 * A failed mutation must carry its own outcome evidence, and every piece of it
 * must describe the request that was sent.
 */
function matchesFailure(
  request: ForgeRequest,
  response: Extract<ForgeResponse, { ok: false }>
): boolean {
  if (!isMutationRequest(request)) return response.mutation === undefined;
  const evidence = response.mutation;
  if (evidence?.op !== request.op) return false;
  return (
    sameTarget(evidence.target, mutationTarget(request)) &&
    matchesAttemptEvidence(request, evidence) &&
    matchesObservedEvidence(request, evidence) &&
    matchesWorkitemEvidence(request, evidence) &&
    matchesLabelEvidence(request, evidence)
  );
}

function byRef(request: { ref: PrRef }, value: { ref: PrRef }): boolean {
  return sameRef(value.ref, request.ref);
}

function labelChange(
  request: OpRequest<'workitem.label.add' | 'workitem.label.remove'>,
  value: OpValue<'workitem.label.add' | 'workitem.label.remove'>
): boolean {
  return (
    sameTarget(value.target, request.subject.ref) &&
    sameSubject(value.workitem, request.subject) &&
    value.labels.includes(request.name) === (request.op === 'workitem.label.add')
  );
}

function draftChange(
  request: OpRequest<'pr.ready' | 'pr.draft'>,
  value: OpValue<'pr.ready' | 'pr.draft'>
): boolean {
  return (
    sameTarget(value.target, mutationTarget(request)) &&
    sameRef(value.pr, request.ref) &&
    value.pr.state === 'open' &&
    value.pr.is_draft === (request.op === 'pr.draft')
  );
}

function matchesPrView(request: OpRequest<'pr.view'>, value: OpValue<'pr.view'>): boolean {
  const selector = request.selector;
  // Only a head selector may find nothing; an explicit number must resolve.
  if (!value) return selector.kind === 'head';
  if (selector.kind === 'number') return sameRef(value.pr, selector.ref);
  // A head selector asks for the branch's open pull request, never a closed one.
  return (
    value.pr.state === 'open' &&
    sameRepo(value.pr.repo, selector.repo) &&
    value.pr.head === selector.head &&
    value.pr.head_repo !== null &&
    sameRepo(value.pr.head_repo, selector.headRepo) &&
    (selector.base === undefined || value.pr.base === selector.base)
  );
}

function matchesMerge(
  request: OpRequest<'pr.merge'>,
  value: OpValue<'pr.merge'>,
  { metadata }: MatchContext
): boolean {
  const supported = metadata.mutationConditions?.['pr.merge'] ?? [];
  return (
    sameTarget(value.target, request.ref) &&
    sameRef(value.pr, request.ref) &&
    value.pr.state === 'merged' &&
    request.conditions.head !== undefined &&
    value.pr.head_revision === request.conditions.head &&
    value.method === request.method &&
    mergeConditionSchema.options.every(key => value.conditions[key] === request.conditions[key]) &&
    Object.keys(request.conditions).every(key =>
      value.enforcedConditions.some(condition => condition === key)
    ) &&
    value.enforcedConditions.every(key => supported.includes(key))
  );
}

/** One matcher per operation: each checks a successful result against the request that asked for it. */
const resultMatchers: { [Op in ForgeOp]: ResultMatcher<Op> } = {
  resolve: (request, value, { metadata, host }) =>
    value.kind === 'none' ||
    (matchesResolvedHost(request, value.repo.host, host) &&
      value.forge === metadata.forge &&
      value.plugin.name === metadata.name &&
      value.plugin.version === metadata.version),
  'pr.reviews': byRef,
  'pr.threads': byRef,
  'checks.state': byRef,
  'workitem.view': byRef,
  'pr.view': matchesPrView,
  'repo.labels.list': (request, value) => sameRepo(value.repo, request.repo),
  'workitem.list': (request, value) =>
    sameRepo(value.repo, request.repo) &&
    value.label === request.label &&
    value.items.every(item => item.state === 'open' && sameRepo(item.ref.repo, request.repo)),
  'workitem.create': (request, value) =>
    sameTarget(value.target, request.repo) &&
    sameRepo(value.workitem.ref.repo, request.repo) &&
    value.markerDigest === contentDigest(request.marker) &&
    (!value.changed ||
      (value.workitem.state === 'open' &&
        value.titleDigest === contentDigest(request.title) &&
        value.bodyDigest === contentDigest(request.body))),
  'workitem.labels.set': (request, value) =>
    sameTarget(value.target, request.ref) &&
    sameRef(value.workitem.ref, request.ref) &&
    value.labels.length === request.labels.length &&
    request.labels.every(name => value.labels.includes(name)),
  'workitem.label.add': labelChange,
  'workitem.label.remove': labelChange,
  'workitem.close': (request, value) =>
    sameTarget(value.target, request.ref) &&
    sameRef(value.workitem.ref, request.ref) &&
    value.workitem.state === 'closed' &&
    value.reason === request.reason,
  'repo.label.ensure': (request, value) =>
    sameTarget(value.target, request.repo) &&
    value.label.name === request.name &&
    (!value.changed ||
      (value.label.color === request.color &&
        value.label.descriptionDigest === contentDigest(request.description))),
  'pr.merge': matchesMerge,
  'checks.rerun': (request, value) =>
    sameTarget(value.target, request.ref) &&
    sameRef(value.ref, request.ref) &&
    value.revision === request.revision &&
    value.units.length === request.units.length &&
    request.units.every(selected => value.units.some(observed => newerAttempt(observed, selected))),
  'comment.upsert': (request, value) =>
    sameTarget(value.target, mutationTarget(request)) &&
    sameRef(value.comment.ref, request.ref) &&
    value.comment.bodyDigest === contentDigest(request.body),
  'workitem.comment.upsert': (request, value) =>
    sameTarget(value.target, request.subject.ref) &&
    sameSubject(value.workitem, request.subject) &&
    sameRef(value.comment.ref, request.subject.ref) &&
    value.comment.bodyDigest === contentDigest(request.body),
  'pr.create': (request, value) =>
    sameTarget(value.target, mutationTarget(request)) &&
    sameRepo(value.pr.repo, request.repo) &&
    value.pr.head_repo !== null &&
    sameRepo(value.pr.head_repo, request.headRepo) &&
    value.pr.head === request.head &&
    value.pr.base === request.base &&
    value.pr.head_revision === request.headRevision &&
    value.pr.is_draft === request.draft &&
    value.pr.state === 'open',
  'pr.edit-body': (request, value) =>
    sameTarget(value.target, mutationTarget(request)) &&
    sameRef(value.pr, request.ref) &&
    value.bodyDigest === contentDigest(request.body),
  'pr.ready': draftChange,
  'pr.draft': draftChange,
  'pr.thread.reply': (request, value) =>
    sameTarget(value.target, request.ref) &&
    value.thread === request.thread &&
    sameRef(value.comment.ref, request.ref) &&
    value.comment.bodyDigest === contentDigest(request.body),
  'pr.thread.resolve': (request, value) =>
    sameTarget(value.target, request.ref) && value.thread === request.thread && value.resolved,
  'workitem.edit-body': (request, value) =>
    sameTarget(value.target, request.ref) &&
    sameRef(value.workitem.ref, request.ref) &&
    value.bodyDigest === contentDigest(request.body),
};

function matchesResult(request: ForgeRequest, result: ForgeResult, context: MatchContext): boolean {
  if (result.op !== request.op) return false;
  // The equal `op` pairs the request with its own result shape; TypeScript cannot
  // correlate the two unions, so the matcher is widened after that check.
  const matcher = resultMatchers[request.op] as ResultMatcher<ForgeOp>;
  return matcher(request, result.value, context);
}

/**
 * Whether a plugin's response answers the request that was sent.
 *
 * A mutation's applied result is checked against what was asked rather than
 * trusted: the plugin claims it read the write back, and this is where that claim
 * meets the request. A failed mutation must carry its own outcome evidence — a
 * plugin that omits it has not said whether anything was written, and the caller
 * gets `outcome_unknown` instead of a refusal it did not earn.
 */
export function matchesForgeOperationResponse(
  request: ForgeRequest,
  response: ForgeResponse,
  metadata: PluginMetadata,
  host: string
): boolean {
  if (!response.ok) return matchesFailure(request, response);
  return matchesResult(request, response.result, { metadata, host });
}
