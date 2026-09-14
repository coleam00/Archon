import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { evidenceReferenceSchema, MERGE_METHODS, qualificationRequirementsSchema, qualificationRequirementsFromEnv, inspectQualifications, type EvidenceReference, type MergeMethod, type QualificationRequirements } from '../../../../../packages/workflows/src/defaults/sdlc/qualified-evidence';

export { MERGE_METHODS, type MergeMethod };

type HoldKind = 'code' | 'policy' | 'checks' | 'evidence' | 'stale' | 'authorization';

export interface Hold {
  kind: HoldKind;
  reason: string;
}

interface RequiredCheck {
  context: string;
  source: 'run' | 'status' | 'either';
  integrationId?: number;
}

interface MethodPolicy {
  state: 'known' | 'unknown';
  allowedMethods: MergeMethod[];
  queueMethod: MergeMethod | null;
}

interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  integrationId?: number;
}

interface CommitStatus {
  id: number;
  context: string;
  state: string;
}

export interface PullRequestFacts {
  url: string;
  repository: string;
  number: number;
  state: string;
  draft: boolean;
  headSha: string;
  headRepository: string;
  base: string;
  liveBaseSha: string;
  mergeable: boolean | null;
  reviewDecision: string;
  reviewFingerprint: string;
  reviewEvidence: {
    reviews: unknown;
    issueComments: unknown;
    lineComments: unknown;
    threads: unknown;
  };
  requiredPolicy: 'none' | 'known' | 'unknown';
  requiredChecks: RequiredCheck[];
  methodPolicy: MethodPolicy;
  checkState: 'passing' | 'failing' | 'pending' | 'missing' | 'unknown';
  holds: Hold[];
}

export interface MergeFacts {
  repository: string;
  enabledMethods: MergeMethod[];
  pullRequests: PullRequestFacts[];
  holds: Hold[];
  fingerprint: string;
}

export interface SemanticAssessment {
  ready: boolean;
  summary: string;
  holds: Hold[];
  method: MergeMethod | '';
  method_source: 'caller' | 'project' | '';
  method_conflict: string;
}

export interface MergePlan {
  version: 1;
  repository: string;
  base: string;
  baseSha: string;
  method: MergeMethod;
  methodSource: 'caller' | 'project' | 'repository';
  factsFingerprint: string;
  qualifications: EvidenceReference[];
  requirements: QualificationRequirements;
  pullRequests: Array<{
    number: number;
    url: string;
    headSha: string;
    reviewFingerprint: string;
  }>;
}

export interface GitHubAdapter {
  api(endpoint: string): Promise<unknown>;
  graphql(query: string, variables: Readonly<Record<string, string | number>>): Promise<unknown>;
  checkoutRepository(): Promise<string>;
  merge(repository: string, number: number, method: MergeMethod, headSha: string): Promise<void>;
}

export interface PlanResult {
  ready: boolean;
  summary: string;
  method: MergeMethod | '';
  holds: Hold[];
  plan?: MergePlan;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(argv: readonly string[]): CommandResult;
}

export interface MergeResult {
  merged: boolean;
  urls: string[];
  queued: string[];
  summary: string;
  holds: Hold[];
}

interface ApiFailure {
  readonly failure: string;
}

const SUCCESSFUL_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function mergePlanDigest(plan: MergePlan): string {
  return hash(plan);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function recordPages(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: Record<string, unknown>[] = [];
  for (const page of value) {
    if (Array.isArray(page)) {
      const records = recordPages(page);
      if (records === undefined) return undefined;
      result.push(...records);
      continue;
    }
    const item = record(page);
    if (item === undefined) return undefined;
    result.push(item);
  }
  return result;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function isFailure(value: unknown): value is ApiFailure {
  return record(value) !== undefined && typeof record(value)?.failure === 'string';
}

function parsePullUrl(url: string): { repository: string; number: number } | undefined {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/);
    if (parsed.hostname !== 'github.com' || match === null) return undefined;
    return { repository: match[1]!, number: Number(match[2]) };
  } catch {
    return undefined;
  }
}

function enabledMethods(repository: Record<string, unknown>): MergeMethod[] {
  return MERGE_METHODS.filter(method => {
    const key = method === 'merge' ? 'allow_merge_commit' : `allow_${method}_merge`;
    return repository[key] === true;
  });
}

interface RulesetPolicy {
  checks: RequiredCheck[];
  allowedMethods: MergeMethod[];
  queueMethod: MergeMethod | null;
}

function rulesetPolicy(rules: unknown): RulesetPolicy | undefined {
  if (isFailure(rules)) return undefined;
  const ruleRecords = recordPages(rules);
  if (ruleRecords === undefined) return undefined;
  const checks = new Map<string, RequiredCheck>();
  let allowedMethods = [...MERGE_METHODS];
  let queueMethod: MergeMethod | null = null;
  for (const rule of ruleRecords) {
    if (rule.type === 'required_status_checks') {
      const parameters = record(rule.parameters);
      const candidates = recordPages(parameters?.required_status_checks);
      if (parameters === undefined || candidates === undefined) return undefined;
      for (const candidate of candidates) {
        const context = string(candidate.context);
        if (context === '') return undefined;
        const integrationId = integer(candidate.integration_id);
        if (candidate.integration_id !== undefined && integrationId === undefined) return undefined;
        checks.set(`either:${context}:${String(integrationId ?? '')}`, {
          context,
          source: 'either',
          ...(integrationId === undefined ? {} : { integrationId }),
        });
      }
    } else if (rule.type === 'pull_request') {
      const candidates = record(rule.parameters)?.allowed_merge_methods;
      if (!Array.isArray(candidates) || candidates.length === 0 ||
        !candidates.every(candidate => MERGE_METHODS.includes(candidate as MergeMethod))) return undefined;
      allowedMethods = allowedMethods.filter(method => candidates.includes(method));
    } else if (rule.type === 'required_linear_history') {
      allowedMethods = allowedMethods.filter(method => method !== 'merge');
    } else if (rule.type === 'merge_queue') {
      const configured = string(record(rule.parameters)?.merge_method).toLowerCase();
      const method = MERGE_METHODS.find(candidate => candidate === configured);
      if (method === undefined || (queueMethod !== null && queueMethod !== method)) return undefined;
      queueMethod = method;
    }
  }
  if (allowedMethods.length === 0) return undefined;
  return { checks: [...checks.values()], allowedMethods, queueMethod };
}

function classicLinearHistory(branch: unknown, protection: unknown): boolean | undefined {
  if (isFailure(branch)) return undefined;
  const branchRecord = record(branch);
  if (branchRecord === undefined || typeof branchRecord.protected !== 'boolean') return undefined;
  if (!branchRecord.protected) return false;
  if (isFailure(protection)) return undefined;
  const enabled = record(record(protection)?.required_linear_history)?.enabled;
  return typeof enabled === 'boolean' ? enabled : undefined;
}

function classicChecks(branch: unknown, protection: unknown): RequiredCheck[] | undefined {
  if (isFailure(branch)) return undefined;
  const branchRecord = record(branch);
  if (branchRecord === undefined || typeof branchRecord.protected !== 'boolean') return undefined;
  if (!branchRecord.protected) return [];
  if (isFailure(protection)) return undefined;
  const protectionRecord = record(protection);
  if (protectionRecord?.required_status_checks === null) return [];
  return classicRequirements(protectionRecord?.required_status_checks);
}

function classicRequirements(policy: unknown): RequiredCheck[] | undefined {
  const value = record(policy);
  if (value === undefined) return undefined;
  const contexts = value.contexts;
  const checksValue = value.checks;
  if (!Array.isArray(contexts) || !contexts.every(context => typeof context === 'string')) {
    return undefined;
  }
  const checks = recordPages(checksValue);
  if (checks === undefined) return undefined;
  const required = new Map<string, RequiredCheck>();
  for (const context of contexts) {
    if (context === '') return undefined;
    if (!checks.some(check => check.context === context)) {
      required.set(`either:${context}:`, { context, source: 'either' });
    }
  }
  for (const check of checks) {
    const context = string(check.context);
    const integrationId = check.app_id === -1 ? undefined : integer(check.app_id);
    if (context === '' || (check.app_id !== null && check.app_id !== -1 && integrationId === undefined)) return undefined;
    required.set(`either:${context}:${String(integrationId ?? '')}`, {
      context,
      source: 'either',
      ...(integrationId === undefined ? {} : { integrationId }),
    });
  }
  return [...required.values()];
}

function combineRequirements(
  classic: RequiredCheck[] | undefined,
  ruleset: RequiredCheck[] | undefined
): RequiredCheck[] | undefined {
  if (classic === undefined || ruleset === undefined) return undefined;
  const checks = new Map<string, RequiredCheck>();
  for (const check of [...classic, ...ruleset]) {
    checks.set(`${check.source}:${check.context}:${String(check.integrationId ?? '')}`, check);
  }
  return [...checks.values()];
}

function readCheckRuns(value: unknown): CheckRun[] | undefined {
  if (isFailure(value)) return undefined;
  const singlePage = record(value);
  const pages = singlePage === undefined ? recordPages(value) : [singlePage];
  if (pages === undefined) return undefined;
  const result: CheckRun[] = [];
  for (const page of pages) {
    const rawRuns = recordPages(page.check_runs);
    if (rawRuns === undefined) return undefined;
    for (const run of rawRuns) {
      const id = integer(run.id);
      const name = string(run.name);
      const status = string(run.status);
      const conclusion = run.conclusion === null ? null : string(run.conclusion);
      const integrationId = integer(record(run.app)?.id);
      if (id === undefined || name === '' || status === '' || (run.app !== undefined && integrationId === undefined)) {
        return undefined;
      }
      result.push({ id, name, status, conclusion, ...(integrationId === undefined ? {} : { integrationId }) });
    }
  }
  return result;
}

function readStatuses(value: unknown): CommitStatus[] | undefined {
  if (isFailure(value)) return undefined;
  const statusRecords = recordPages(value);
  if (statusRecords === undefined) return undefined;
  const result: CommitStatus[] = [];
  for (const status of statusRecords) {
    const id = integer(status.id);
    const context = string(status.context);
    const state = string(status.state);
    if (id === undefined || context === '' || state === '') return undefined;
    result.push({ id, context, state });
  }
  return result;
}

function classifyChecks(
  required: RequiredCheck[],
  runs: CheckRun[] | undefined,
  statuses: CommitStatus[] | undefined
): PullRequestFacts['checkState'] {
  if (required.length === 0) return 'passing';
  if (runs === undefined || statuses === undefined) return 'unknown';
  let sawPending = false;
  let sawMissing = false;
  for (const requirement of required) {
    const matchingRuns = runs
      .filter(
        run =>
          run.name === requirement.context &&
          (requirement.integrationId === undefined || run.integrationId === requirement.integrationId)
      )
      .sort((left, right) => right.id - left.id)
      .slice(0, 1);
    const matchingStatuses = statuses
      .filter(status => status.context === requirement.context)
      .sort((left, right) => right.id - left.id)
      .slice(0, 1);
    if (requirement.integrationId !== undefined && matchingRuns.length === 0) {
      sawMissing = true;
    }
    const candidates = [
      ...(requirement.source === 'status' ? [] : matchingRuns.map(run => ({
        success: run.status === 'completed' && SUCCESSFUL_CONCLUSIONS.has(run.conclusion ?? ''),
        failure: run.status === 'completed' && !SUCCESSFUL_CONCLUSIONS.has(run.conclusion ?? ''),
        pending: run.status !== 'completed',
      }))),
      ...(requirement.source === 'run' ? [] : matchingStatuses.map(status => ({
        success: status.state === 'success',
        failure: ['failure', 'error'].includes(status.state),
        pending: status.state === 'pending',
      }))),
    ];
    if (candidates.some(candidate => candidate.failure)) {
      return 'failing';
    }
    if (candidates.some(candidate => candidate.pending)) {
      sawPending = true;
    } else if (candidates.length === 0 || candidates.some(candidate => !candidate.success)) {
      sawMissing = true;
    }
  }
  return sawPending ? 'pending' : sawMissing ? 'missing' : 'passing';
}

function factsHolds(pr: Omit<PullRequestFacts, 'holds'>): Hold[] {
  const holds: Hold[] = [];
  if (pr.state !== 'open') holds.push({ kind: 'code', reason: `${pr.url} is not open` });
  if (pr.draft) holds.push({ kind: 'code', reason: `${pr.url} is a draft` });
  if (pr.headRepository !== pr.repository) {
    holds.push({ kind: 'policy', reason: `${pr.url} is not a same-repository pull request` });
  }
  if (pr.mergeable !== true) {
    holds.push({
      kind: pr.mergeable === false ? 'code' : 'policy',
      reason: `${pr.url} mergeability is ${pr.mergeable === false ? 'blocked' : 'unknown'}`,
    });
  }
  if (pr.requiredPolicy === 'unknown') {
    holds.push({ kind: 'policy', reason: `${pr.url} effective required-check policy is unknown` });
  } else if (pr.checkState !== 'passing') {
    holds.push({ kind: 'checks', reason: `${pr.url} required checks are ${pr.checkState}` });
  }
  if (pr.methodPolicy.state === 'unknown') {
    holds.push({ kind: 'policy', reason: `${pr.url} effective merge-method policy is unknown` });
  } else if (pr.methodPolicy.allowedMethods.length === 0) {
    holds.push({ kind: 'policy', reason: `${pr.url} effective merge-method policy allows no repository method` });
  }
  return holds;
}

function methodPolicyAllows(policy: MethodPolicy, method: MergeMethod): boolean {
  return policy.state === 'known' && policy.allowedMethods.includes(method) &&
    (policy.queueMethod === null || policy.queueMethod === method);
}

async function safeApi(adapter: GitHubAdapter, endpoint: string): Promise<unknown | ApiFailure> {
  try {
    return await adapter.api(endpoint);
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

async function collectGraphqlPolicy(
  adapter: GitHubAdapter,
  repository: string,
  branch: string,
  baseSha: string
): Promise<{ classic?: RequiredCheck[]; ruleset?: RequiredCheck[]; classicLinear?: boolean }> {
  const [owner, name] = repository.split('/');
  let response: unknown;
  try {
    response = await adapter.graphql(
      `query($owner:String!,$name:String!,$ref:String!) {
        repository(owner:$owner,name:$name) {
          nameWithOwner
          ref(qualifiedName:$ref) {
            name target { oid }
            branchProtectionRule {
              requiresStatusChecks requiresLinearHistory requiredStatusCheckContexts
              requiredStatusChecks { context app { databaseId } }
            }
          }
          rulesets(first:100,includeParents:true) {
            totalCount nodes { id } pageInfo { hasNextPage }
          }
        }
      }`,
      { owner: owner!, name: name!, ref: `refs/heads/${branch}` }
    );
  } catch {
    return {};
  }
  const envelope = record(response);
  if (envelope === undefined || (envelope.errors !== undefined &&
    (!Array.isArray(envelope.errors) || envelope.errors.length !== 0))) return {};
  const repo = record(record(envelope.data)?.repository);
  const ref = record(repo?.ref);
  if (repo?.nameWithOwner !== repository || ref?.name !== branch ||
    baseSha === '' || record(ref.target)?.oid !== baseSha) return {};

  let classic: RequiredCheck[] | undefined;
  let classicLinear: boolean | undefined;
  const protection = record(ref.branchProtectionRule);
  if (ref.branchProtectionRule === null) classicLinear = false;
  else if (typeof protection?.requiresLinearHistory === 'boolean') classicLinear = protection.requiresLinearHistory;
  if (ref.branchProtectionRule === null || protection?.requiresStatusChecks === false) {
    classic = [];
  } else if (protection?.requiresStatusChecks === true) {
    const checks = recordPages(protection.requiredStatusChecks);
    if (checks !== undefined) {
      classic = classicRequirements({
        contexts: protection.requiredStatusCheckContexts,
        checks: checks.map(check => ({
          context: check.context,
          app_id: check.app === null ? null : record(check.app)?.databaseId,
        })),
      });
    }
  }
  const rulesets = record(repo.rulesets);
  // Nonempty GraphQL rulesets need effective REST rules; listing is not applicability.
  const noRulesets = rulesets?.totalCount === 0 && Array.isArray(rulesets.nodes) &&
    rulesets.nodes.length === 0 && record(rulesets.pageInfo)?.hasNextPage === false;
  return {
    ...(classic === undefined ? {} : { classic }),
    ...(noRulesets ? { ruleset: [] } : {}),
    ...(classicLinear === undefined ? {} : { classicLinear }),
  };
}

async function collectReviewThreads(
  adapter: GitHubAdapter,
  repository: string,
  number: number
): Promise<unknown[] | ApiFailure> {
  const [owner, name] = repository.split('/');
  const threads: unknown[] = [];
  let cursor = '';
  do {
    let response: unknown;
    try {
      response = await adapter.graphql(
        `query($owner:String!,$name:String!,$number:Int!,$cursor:String) {
          repository(owner:$owner,name:$name) {
            pullRequest(number:$number) {
              reviewThreads(first:100,after:$cursor) {
                nodes { isResolved comments(first:100) { nodes { id body author { login } } pageInfo { hasNextPage } } }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        { owner: owner!, name: name!, number, cursor }
      );
    } catch (error) {
      return { failure: error instanceof Error ? error.message : String(error) };
    }
    const connection = record(
      record(record(record(response)?.data)?.repository)?.pullRequest
    )?.reviewThreads;
    const connectionRecord = record(connection);
    if (connectionRecord === undefined) return { failure: 'review thread response is incomplete' };
    const nodes = Array.isArray(connectionRecord.nodes) ? connectionRecord.nodes : undefined;
    const pageInfo = record(connectionRecord.pageInfo);
    if (nodes === undefined || pageInfo === undefined || typeof pageInfo.hasNextPage !== 'boolean') {
      return { failure: 'review thread pagination is incomplete' };
    }
    for (const node of nodes) {
      const comments = record(record(node)?.comments);
      if (record(comments?.pageInfo)?.hasNextPage === true) {
        return { failure: 'a review thread has more than 100 comments' };
      }
      threads.push(node);
    }
    if (!pageInfo.hasNextPage) break;
    cursor = string(pageInfo.endCursor);
    if (cursor === '') return { failure: 'review thread pagination cursor is missing' };
  } while (true);
  return threads;
}

export async function collectMergeFacts(
  urls: readonly string[],
  adapter: GitHubAdapter
): Promise<MergeFacts> {
  const identities = urls.map(parsePullUrl);
  const identityHolds: Hold[] = [];
  if (urls.length < 1 || urls.length > 5) {
    identityHolds.push({ kind: 'policy', reason: 'the batch must contain 1-5 pull requests' });
  }
  if (identities.some(identity => identity === undefined)) {
    identityHolds.push({ kind: 'policy', reason: 'every pull request must be an explicit GitHub URL' });
  }
  const repositories = new Set(identities.flatMap(identity => (identity ? [identity.repository] : [])));
  if (repositories.size !== 1) {
    identityHolds.push({ kind: 'policy', reason: 'all pull requests must belong to one repository' });
  }
  if (new Set(urls).size !== urls.length) {
    identityHolds.push({ kind: 'policy', reason: 'the batch contains duplicate pull requests' });
  }
  const repository = [...repositories][0] ?? '';
  if (identityHolds.length > 0) {
    return {
      repository,
      enabledMethods: [],
      pullRequests: [],
      holds: identityHolds,
      fingerprint: hash(identityHolds),
    };
  }

  const repositoryValue = await safeApi(adapter, `repos/${repository}`);
  let checkoutRepository = '';
  try {
    checkoutRepository = await adapter.checkoutRepository();
  } catch {
    checkoutRepository = '';
  }
  const repositoryRecord = record(repositoryValue);
  const methods = repositoryRecord === undefined || isFailure(repositoryValue)
    ? []
    : enabledMethods(repositoryRecord);
  const repositoryHolds: Hold[] = repositoryRecord === undefined || isFailure(repositoryValue)
    ? [{ kind: 'policy', reason: 'repository merge settings are unknown' }]
    : methods.length === 0
      ? [{ kind: 'policy', reason: 'the repository has no enabled merge method' }]
      : [];
  if (checkoutRepository === '' || checkoutRepository.toLowerCase() !== repository.toLowerCase()) {
    repositoryHolds.push({ kind: 'policy', reason: 'pull requests do not belong to the checkout origin' });
  }

  const pullRequests: PullRequestFacts[] = [];
  for (let index = 0; index < identities.length; index += 1) {
    const identity = identities[index]!;
    const url = urls[index]!;
    const pullValue = await safeApi(adapter, `repos/${repository}/pulls/${String(identity.number)}`);
    const pull = record(pullValue);
    if (pull === undefined || isFailure(pullValue)) {
      const hold = { kind: 'policy', reason: `${url} could not be read` } satisfies Hold;
      pullRequests.push({
        url,
        repository,
        number: identity.number,
        state: 'unknown',
        draft: false,
        headSha: '',
        headRepository: '',
        base: '',
        liveBaseSha: '',
        mergeable: null,
        reviewDecision: '',
        reviewFingerprint: '',
        reviewEvidence: { reviews: [], issueComments: [], lineComments: [], threads: [] },
        requiredPolicy: 'unknown',
        requiredChecks: [],
        methodPolicy: { state: 'unknown', allowedMethods: [], queueMethod: null },
        checkState: 'unknown',
        holds: [hold],
      });
      continue;
    }
    const head = record(pull.head);
    const base = record(pull.base);
    const baseName = string(base?.ref);
    const headSha = string(head?.sha);
    const branchValue = await safeApi(
      adapter,
      `repos/${repository}/branches/${encodeURIComponent(baseName)}`
    );
    const protectionValue = record(branchValue)?.protected === true
      ? await safeApi(
          adapter,
          `repos/${repository}/branches/${encodeURIComponent(baseName)}/protection`
        )
      : null;
    const [rulesValue, runsValue, statusesValue, reviewsValue, commentsValue, linesValue, threadsValue] =
      await Promise.all([
        safeApi(adapter, `repos/${repository}/rules/branches/${encodeURIComponent(baseName)}?per_page=100`),
        safeApi(adapter, `repos/${repository}/commits/${headSha}/check-runs?per_page=100`),
        safeApi(adapter, `repos/${repository}/commits/${headSha}/statuses?per_page=100`),
        safeApi(adapter, `repos/${repository}/pulls/${String(identity.number)}/reviews?per_page=100`),
        safeApi(adapter, `repos/${repository}/issues/${String(identity.number)}/comments?per_page=100`),
        safeApi(adapter, `repos/${repository}/pulls/${String(identity.number)}/comments?per_page=100`),
        collectReviewThreads(adapter, repository, identity.number),
      ]);
    const classic = classicChecks(branchValue, protectionValue);
    const ruleset = rulesetPolicy(rulesValue);
    const classicLinear = classicLinearHistory(branchValue, protectionValue);
    // Permissions differ between GitHub APIs. Only a complete independent read can
    // resolve an unknown REST policy; error text is never evidence of no protection.
    const fallback = classic === undefined || ruleset === undefined || classicLinear === undefined
      ? await collectGraphqlPolicy(adapter, repository, baseName,
          string(record(record(branchValue)?.commit)?.sha))
      : {};
    const requirements = combineRequirements(classic ?? fallback.classic, ruleset?.checks ?? fallback.ruleset);
    const effectiveClassicLinear = classicLinear ?? fallback.classicLinear;
    const effectiveRuleset = ruleset ?? (fallback.ruleset === undefined ? undefined : {
      checks: fallback.ruleset,
      allowedMethods: [...MERGE_METHODS],
      queueMethod: null,
    });
    const methodPolicy: MethodPolicy = effectiveRuleset === undefined || effectiveClassicLinear === undefined
      ? { state: 'unknown', allowedMethods: [], queueMethod: null }
      : {
          state: 'known',
          allowedMethods: methods.filter(method =>
            effectiveRuleset.allowedMethods.includes(method) && (!effectiveClassicLinear || method !== 'merge')
          ),
          queueMethod: effectiveRuleset.queueMethod,
        };
    const runs = readCheckRuns(runsValue);
    const statuses = readStatuses(statusesValue);
    const reviewMaterial = [pull.review_decision, reviewsValue, commentsValue, linesValue, threadsValue];
    const partial = {
      url,
      repository,
      number: identity.number,
      state: string(pull.state),
      draft: pull.draft === true,
      headSha,
      headRepository: string(record(head?.repo)?.full_name),
      base: baseName,
      liveBaseSha: string(record(record(branchValue)?.commit)?.sha),
      mergeable: typeof pull.mergeable === 'boolean' ? pull.mergeable : null,
      reviewDecision: string(pull.review_decision),
      reviewFingerprint: hash(reviewMaterial),
      reviewEvidence: {
        reviews: reviewsValue,
        issueComments: commentsValue,
        lineComments: linesValue,
        threads: threadsValue,
      },
      requiredPolicy: requirements === undefined ? 'unknown' : requirements.length === 0 ? 'none' : 'known',
      requiredChecks: requirements ?? [],
      methodPolicy,
      checkState: requirements === undefined ? 'unknown' : classifyChecks(requirements, runs, statuses),
    } satisfies Omit<PullRequestFacts, 'holds'>;
    const holds = factsHolds(partial);
    if (partial.liveBaseSha === '') {
      holds.push({ kind: 'policy', reason: `${url} live base branch could not be read` });
    }
    if (isFailure(threadsValue)) {
      holds.push({ kind: 'policy', reason: `${url} review thread state is unknown` });
    }
    if ([reviewsValue, commentsValue, linesValue].some(value => recordPages(value) === undefined)) {
      holds.push({ kind: 'policy', reason: `${url} review evidence is incomplete` });
    }
    pullRequests.push({ ...partial, holds });
  }

  const bases = new Set(pullRequests.map(pr => pr.base));
  const batchHolds = [...repositoryHolds, ...pullRequests.flatMap(pr => pr.holds)];
  if (bases.size !== 1) batchHolds.push({ kind: 'policy', reason: 'all pull requests must target one base' });
  const result = { repository, enabledMethods: methods, pullRequests, holds: batchHolds };
  return { ...result, fingerprint: hash(result) };
}

export function createMergePlan(
  facts: MergeFacts,
  assessment: SemanticAssessment,
  requestedMethod: string,
  qualification: { references: EvidenceReference[]; requirements: QualificationRequirements }
): PlanResult {
  const holds = [...facts.holds, ...assessment.holds];
  if (qualification.references.length === 0) holds.push({ kind: 'evidence', reason: 'qualified records are required' });
  if (!assessment.ready && assessment.holds.length === 0) {
    holds.push({ kind: 'evidence', reason: 'semantic assessment is not ready and supplies no classified reasons' });
  }
  if (assessment.method_conflict !== '') {
    holds.push({ kind: 'policy', reason: assessment.method_conflict });
  }

  const requested = MERGE_METHODS.find(method => method === requestedMethod);
  if (requestedMethod !== '' && requested === undefined) {
    holds.push({ kind: 'policy', reason: `unsupported requested merge method: ${requestedMethod}` });
  }
  let method: MergeMethod | undefined;
  let methodSource: MergePlan['methodSource'] | undefined;
  if (requested !== undefined) {
    method = requested;
    methodSource = 'caller';
    if (assessment.method !== requested || assessment.method_source !== 'caller') {
      holds.push({ kind: 'policy', reason: 'the assessed merge method conflicts with the caller request' });
    }
  } else if (assessment.method !== '') {
    method = assessment.method;
    methodSource = assessment.method_source === 'project' ? 'project' : undefined;
    if (methodSource === undefined) {
      holds.push({ kind: 'policy', reason: 'the merge method has no caller or project source' });
    }
  } else if (facts.enabledMethods.length === 1) {
    method = facts.enabledMethods[0];
    methodSource = 'repository';
  } else {
    holds.push({ kind: 'policy', reason: 'the merge method is unresolved' });
  }
  if (method !== undefined && !facts.enabledMethods.includes(method)) {
    holds.push({ kind: 'policy', reason: `merge method ${method} is disabled in the repository` });
  }
  if (method !== undefined) {
    for (const pull of facts.pullRequests) {
      if (!methodPolicyAllows(pull.methodPolicy, method)) {
        holds.push({ kind: 'policy', reason: `${pull.url} effective policy does not permit merge method ${method}` });
      }
    }
  }
  const bases = new Set(facts.pullRequests.map(pr => `${pr.base}:${pr.liveBaseSha}`));
  if (bases.size !== 1) holds.push({ kind: 'stale', reason: 'pull requests do not share one live base identity' });

  if (holds.length > 0 || method === undefined || methodSource === undefined) {
    return {
      ready: false,
      summary: holds.map(hold => hold.reason).join('; '),
      method: method ?? '',
      holds,
    };
  }
  const first = facts.pullRequests[0]!;
  const plan: MergePlan = {
    version: 1,
    repository: facts.repository,
    base: first.base,
    baseSha: first.liveBaseSha,
    method,
    methodSource,
    factsFingerprint: facts.fingerprint,
    qualifications: qualification.references,
    requirements: qualification.requirements,
    pullRequests: facts.pullRequests.map(pr => ({
      number: pr.number,
      url: pr.url,
      headSha: pr.headSha,
      reviewFingerprint: pr.reviewFingerprint,
    })),
  };
  return {
    ready: true,
    summary: `${plan.pullRequests.length} pull request(s) approved for ${method}`,
    method,
    holds: [],
    plan,
  };
}

function authorized(mode: string, approval: unknown): boolean {
  if (mode === 'auto') return true;
  return mode === 'approve' && record(approval)?.decision === 'approve';
}

export async function executeMergePlan(
  plan: MergePlan,
  mode: string,
  approval: unknown,
  adapter: GitHubAdapter,
  expectedDigest = mergePlanDigest(plan),
  verifyEvidence = inspectQualifications,
  currentRequirements = plan.requirements,
  currentMethod: string = plan.method
): Promise<MergeResult> {
  if (mergePlanDigest(plan) !== expectedDigest || (currentMethod !== '' && currentMethod !== plan.method)) {
    return {
      merged: false,
      urls: [],
      queued: [],
      summary: 'the approved merge plan digest or requested method does not match',
      holds: [{ kind: 'authorization', reason: 'the approved merge plan digest or requested method does not match' }],
    };
  }
  if (!authorized(mode, approval)) {
    return {
      merged: false,
      urls: [],
      queued: [],
      summary: 'the batch is not authorized',
      holds: [{ kind: 'authorization', reason: 'the batch is not authorized' }],
    };
  }
  const urls = plan.pullRequests.map(pr => pr.url);
  const current = await collectMergeFacts(urls, adapter);
  const holds = [...current.holds];
  holds.push(...(await verifyEvidence(plan.qualifications, currentRequirements, current)).holds);
  if (current.fingerprint !== plan.factsFingerprint) {
    holds.push({ kind: 'stale', reason: 'GitHub facts changed after approval' });
  }
  if (!current.enabledMethods.includes(plan.method)) {
    holds.push({ kind: 'policy', reason: `approved merge method ${plan.method} is no longer enabled` });
  }
  for (const pull of current.pullRequests) {
    if (!methodPolicyAllows(pull.methodPolicy, plan.method)) {
      holds.push({ kind: 'policy', reason: `${pull.url} no longer permits approved merge method ${plan.method}` });
    }
  }
  for (const approved of plan.pullRequests) {
    const actual = current.pullRequests.find(pr => pr.number === approved.number);
    if (actual?.headSha !== approved.headSha) {
      holds.push({ kind: 'stale', reason: `${approved.url} head changed after approval` });
    }
    if (actual?.base !== plan.base || actual.liveBaseSha !== plan.baseSha) {
      holds.push({ kind: 'stale', reason: `${approved.url} base changed after approval` });
    }
    if (actual?.reviewFingerprint !== approved.reviewFingerprint) {
      holds.push({ kind: 'stale', reason: `${approved.url} review content changed after approval` });
    }
  }
  if (holds.length > 0) {
    return { merged: false, urls: [], queued: [], summary: holds.map(h => h.reason).join('; '), holds };
  }

  const merged: string[] = [];
  const queued: string[] = [];
  let expectedBase = plan.baseSha;
  for (let index = 0; index < plan.pullRequests.length; index += 1) {
    const approved = plan.pullRequests[index]!;
    const before = await collectMergeFacts([approved.url], adapter);
    const actual = before.pullRequests[0];
    const prior = current.pullRequests.find(pr => pr.number === approved.number);
    const stepHolds = [...before.holds];
    const immediateFacts = { ...current, pullRequests: current.pullRequests.map(pull => pull.url === actual?.url ? actual : pull) };
    stepHolds.push(...(await verifyEvidence(plan.qualifications, currentRequirements, immediateFacts)).holds);
    if (actual?.headSha !== approved.headSha) {
      stepHolds.push({ kind: 'stale', reason: `${approved.url} head changed before merge` });
    }
    if (actual?.liveBaseSha !== expectedBase) {
      stepHolds.push({ kind: 'stale', reason: `${approved.url} live base moved before merge` });
    }
    if (actual?.reviewFingerprint !== approved.reviewFingerprint) {
      stepHolds.push({ kind: 'stale', reason: `${approved.url} review content changed before merge` });
    }
    if (!before.enabledMethods.includes(plan.method)) {
      stepHolds.push({ kind: 'policy', reason: `approved merge method ${plan.method} is no longer enabled` });
    }
    if (actual !== undefined && !methodPolicyAllows(actual.methodPolicy, plan.method)) {
      stepHolds.push({ kind: 'policy', reason: `${approved.url} no longer permits approved merge method ${plan.method}` });
    }
    if (
      prior === undefined || actual === undefined ||
      hash([actual.requiredPolicy, actual.requiredChecks, actual.checkState, actual.methodPolicy]) !==
        hash([prior.requiredPolicy, prior.requiredChecks, prior.checkState, prior.methodPolicy])
    ) {
      stepHolds.push({ kind: 'stale', reason: `${approved.url} required checks changed before merge` });
    }
    if (index > 0) {
      stepHolds.push({
        kind: 'stale',
        reason: `${approved.url} requires validation against the base updated by the prior merge`,
      });
    }
    if (stepHolds.length > 0) {
      return {
        merged: false,
        urls: merged,
        queued,
        summary: stepHolds.map(h => h.reason).join('; '),
        holds: stepHolds,
      };
    }
    let mergeError = '';
    try {
      await adapter.merge(plan.repository, approved.number, plan.method, approved.headSha);
    } catch (error) {
      mergeError = error instanceof Error ? error.message : String(error);
    }
    const readBackValue = await safeApi(
      adapter,
      `repos/${plan.repository}/pulls/${String(approved.number)}`
    );
    const readBack = record(readBackValue);
    if (readBack !== undefined && string(readBack.merged_at) !== '') {
      merged.push(approved.url);
      const branchValue = await safeApi(
        adapter,
        `repos/${plan.repository}/branches/${encodeURIComponent(plan.base)}`
      );
      expectedBase = string(record(record(branchValue)?.commit)?.sha);
      if (expectedBase === '') {
        return {
          merged: false,
          urls: merged,
          queued,
          summary: 'merge completed but the updated base could not be read',
          holds: [{ kind: 'policy', reason: 'updated base is unknown after merge' }],
        };
      }
      continue;
    }
    if (readBack?.state === 'open' && readBack.auto_merge !== null && readBack.auto_merge !== undefined) {
      queued.push(approved.url);
      return {
        merged: false,
        urls: merged,
        queued,
        summary: `${approved.url} was queued but is not merged`,
        holds: [],
      };
    }
    return {
      merged: false,
      urls: merged,
      queued,
      summary: `${approved.url} merge result is unknown${mergeError === '' ? '' : `: ${mergeError}`}`,
      holds: [{
        kind: 'policy',
        reason: `${approved.url} merge result is unknown${mergeError === '' ? '' : `: ${mergeError}`}`,
      }],
    };
  }
  return {
    merged: merged.length === plan.pullRequests.length,
    urls: merged,
    queued,
    summary: `confirmed ${merged.length} merged pull request(s)`,
    holds: [],
  };
}

const bunRunner: CommandRunner = {
  run(argv) {
    const result = Bun.spawnSync([...argv], { stdout: 'pipe', stderr: 'pipe' });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  },
};

export class GhAdapter implements GitHubAdapter {
  constructor(private readonly runner: CommandRunner = bunRunner) {}

  async api(endpoint: string): Promise<unknown> {
    const result = this.runner.run(['gh', 'api', '--paginate', '--slurp', endpoint]);
    if (result.exitCode !== 0) {
      throw new Error(`gh api failed for ${endpoint}: ${result.stderr.trim()}`);
    }
    const parsed = JSON.parse(result.stdout) as unknown;
    return Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
  }

  async graphql(
    query: string,
    variables: Readonly<Record<string, string | number>>
  ): Promise<unknown> {
    const fields = Object.entries(variables).flatMap(([key, value]) => [
      '-F',
      `${key}=${String(value)}`,
    ]);
    const result = this.runner.run(['gh', 'api', 'graphql', '-f', `query=${query}`, ...fields]);
    if (result.exitCode !== 0) {
      throw new Error(`gh graphql failed: ${result.stderr.trim()}`);
    }
    return JSON.parse(result.stdout) as unknown;
  }

  async checkoutRepository(): Promise<string> {
    const result = this.runner.run(['git', 'remote', 'get-url', 'origin']);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'origin remote is unavailable');
    const remote = result.stdout.trim().replace(/\.git$/, '');
    const match = remote.match(/(?:github\.com[/:])([^/]+\/[^/]+)$/);
    if (match === null) throw new Error('origin is not a GitHub repository');
    return match[1]!;
  }

  async merge(
    repository: string,
    number: number,
    method: MergeMethod,
    headSha: string
  ): Promise<void> {
    const result = this.runner.run(mergeArguments(repository, number, method, headSha));
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'gh pr merge failed');
  }
}

export function mergeArguments(
  repository: string,
  number: number,
  method: MergeMethod,
  headSha: string
): string[] {
  return [
    'gh',
    'pr',
    'merge',
    String(number),
    '--repo',
    repository,
    `--${method}`,
    '--match-head-commit',
    headSha,
  ];
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`merge-queue: ${name} is required`);
  return value;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const HOLD_KINDS: readonly HoldKind[] = [
  'code', 'policy', 'checks', 'evidence', 'stale', 'authorization',
];

function isHold(value: unknown): value is Hold {
  const candidate = record(value);
  return candidate !== undefined && HOLD_KINDS.includes(candidate.kind as HoldKind) &&
    typeof candidate.reason === 'string';
}

function isRequiredCheck(value: unknown): value is RequiredCheck {
  const candidate = record(value);
  return candidate !== undefined && typeof candidate.context === 'string' && candidate.context !== '' &&
    ['run', 'status', 'either'].includes(string(candidate.source)) &&
    (candidate.integrationId === undefined || integer(candidate.integrationId) !== undefined);
}

function isMethodPolicy(value: unknown): value is MethodPolicy {
  const candidate = record(value);
  return candidate !== undefined && ['known', 'unknown'].includes(string(candidate.state)) &&
    Array.isArray(candidate.allowedMethods) &&
    candidate.allowedMethods.every(method => MERGE_METHODS.includes(method as MergeMethod)) &&
    (candidate.queueMethod === null || MERGE_METHODS.includes(candidate.queueMethod as MergeMethod));
}

function isPullRequestFacts(value: unknown): value is PullRequestFacts {
  const candidate = record(value);
  const review = record(candidate?.reviewEvidence);
  return candidate !== undefined && typeof candidate.url === 'string' &&
    typeof candidate.repository === 'string' && integer(candidate.number) !== undefined &&
    typeof candidate.state === 'string' && typeof candidate.draft === 'boolean' &&
    typeof candidate.headSha === 'string' && typeof candidate.headRepository === 'string' &&
    typeof candidate.base === 'string' && typeof candidate.liveBaseSha === 'string' &&
    (typeof candidate.mergeable === 'boolean' || candidate.mergeable === null) &&
    typeof candidate.reviewDecision === 'string' && typeof candidate.reviewFingerprint === 'string' &&
    review !== undefined && 'reviews' in review && 'issueComments' in review &&
    'lineComments' in review && 'threads' in review &&
    ['none', 'known', 'unknown'].includes(string(candidate.requiredPolicy)) &&
    Array.isArray(candidate.requiredChecks) && candidate.requiredChecks.every(isRequiredCheck) &&
    isMethodPolicy(candidate.methodPolicy) &&
    ['passing', 'failing', 'pending', 'missing', 'unknown'].includes(string(candidate.checkState)) &&
    Array.isArray(candidate.holds) && candidate.holds.every(isHold);
}

export function isFacts(value: unknown): value is MergeFacts {
  const candidate = record(value);
  return candidate !== undefined && typeof candidate.repository === 'string' &&
    Array.isArray(candidate.enabledMethods) &&
    candidate.enabledMethods.every(method => MERGE_METHODS.includes(method as MergeMethod)) &&
    Array.isArray(candidate.pullRequests) && candidate.pullRequests.every(isPullRequestFacts) &&
    Array.isArray(candidate.holds) && candidate.holds.every(isHold) &&
    typeof candidate.fingerprint === 'string';
}

function isPlan(value: unknown): value is MergePlan {
  const candidate = record(value);
  const pullRequests = candidate?.pullRequests;
  return (
    candidate?.version === 1 &&
    typeof candidate.repository === 'string' && candidate.repository !== '' &&
    typeof candidate.base === 'string' && candidate.base !== '' &&
    typeof candidate.baseSha === 'string' && candidate.baseSha !== '' &&
    MERGE_METHODS.includes(candidate.method as MergeMethod) &&
    ['caller', 'project', 'repository'].includes(string(candidate.methodSource)) &&
    typeof candidate.factsFingerprint === 'string' && candidate.factsFingerprint !== '' &&
    evidenceReferenceSchema.array().min(1).max(5).safeParse(candidate.qualifications).success &&
    qualificationRequirementsSchema.safeParse(candidate.requirements).success &&
    Array.isArray(pullRequests) && pullRequests.length > 0 && pullRequests.every(value => {
      const pull = record(value);
      return pull !== undefined && integer(pull.number) !== undefined &&
        typeof pull.url === 'string' && pull.url !== '' &&
        typeof pull.headSha === 'string' && pull.headSha !== '' &&
        typeof pull.reviewFingerprint === 'string' && pull.reviewFingerprint !== '';
    })
  );
}

async function writeMergeResult(artifactsDir: string, result: MergeResult): Promise<void> {
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(
    join(artifactsDir, 'merge-result.md'),
    `# Merge result\n\n${result.summary}\n\nMerged: ${result.urls.join(', ') || 'none'}\n\nQueued: ${result.queued.join(', ') || 'none'}\n`,
    'utf8'
  );
}

async function main(): Promise<void> {
  const action = requiredEnv('INPUTS_ACTION');
  const artifactsDir = requiredEnv('ARTIFACTS_DIR');
  const adapter = new GhAdapter();
  if (action === 'facts') {
    const urls = JSON.parse(requiredEnv('INPUTS_PRS')) as unknown;
    if (!Array.isArray(urls) || !urls.every(value => typeof value === 'string')) {
      throw new Error('merge-queue: prs must be a JSON string array');
    }
    console.log(JSON.stringify(await collectMergeFacts(urls, adapter)));
    return;
  }
  if (action === 'plan') {
    const facts = JSON.parse(requiredEnv('INPUTS_FACTS')) as unknown;
    if (!isFacts(facts)) throw new Error('merge-queue: facts are malformed');
    const references = evidenceReferenceSchema.array().max(5).parse(JSON.parse(requiredEnv('INPUTS_EVIDENCE')) as unknown);
    const requirements = qualificationRequirementsFromEnv();
    const assessment = await inspectQualifications(references, requirements, facts);
    const qualificationHolds: unknown = JSON.parse(requiredEnv('INPUTS_QUALIFICATION_HOLDS'));
    if (!Array.isArray(qualificationHolds) || !qualificationHolds.every(isHold)) throw new Error('merge-queue: qualification holds are malformed');
    assessment.holds.push(...qualificationHolds);
    if (qualificationHolds.length) assessment.ready = false;
    const result = createMergePlan(facts, assessment, requiredEnv('INPUTS_METHOD'), { references, requirements });
    let planReference = '';
    let planDigest = '';
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      join(artifactsDir, 'merge-hold.md'),
      `# Merge hold\n\n${facts.pullRequests.map(pr => `${pr.url} at ${pr.headSha}`).join('\n')}\n\n${
        result.holds.length === 0
          ? 'No active holds for this assessment.'
          : result.holds.map(hold => `- **${hold.kind}:** ${hold.reason}`).join('\n')
      }\n\n${assessment.summary}\n`,
      'utf8'
    );
    if (result.plan !== undefined) {
      planDigest = mergePlanDigest(result.plan);
      planReference = `merge-plan-${planDigest}.json`;
      await writeJson(join(artifactsDir, planReference), result.plan);
    }
    console.log(JSON.stringify({
      ready: result.ready,
      summary: result.summary,
      method: result.method,
      holds: result.holds,
      plan_reference: planReference,
      plan_digest: planDigest,
    }));
    return;
  }
  if (action === 'execute') {
    if (requiredEnv('INPUTS_READY') !== 'true') {
      const holdsValue = JSON.parse(requiredEnv('INPUTS_PLAN_HOLDS')) as unknown;
      if (!Array.isArray(holdsValue) || !holdsValue.every(isHold)) {
        throw new Error('merge-queue: plan holds are malformed');
      }
      const summary = requiredEnv('INPUTS_PLAN_SUMMARY');
      const result: MergeResult = {
        merged: false,
        urls: [],
        queued: [],
        summary,
        holds: holdsValue,
      };
      await writeMergeResult(artifactsDir, result);
      console.log(JSON.stringify(result));
      return;
    }
    const planReference = requiredEnv('INPUTS_PLAN_REFERENCE');
    const planDigest = requiredEnv('INPUTS_PLAN_DIGEST');
    if (planReference !== `merge-plan-${planDigest}.json`) {
      throw new Error('merge-queue: approved plan reference and digest do not match');
    }
    const planValue = JSON.parse(await readFile(join(artifactsDir, planReference), 'utf8')) as unknown;
    if (!isPlan(planValue)) throw new Error('merge-queue: merge-plan.json is malformed');
    const result = await executeMergePlan(
      planValue,
      requiredEnv('INPUTS_MODE'),
      JSON.parse(requiredEnv('INPUTS_APPROVAL')) as unknown,
      adapter,
      planDigest,
      undefined,
      qualificationRequirementsFromEnv(),
      requiredEnv('INPUTS_METHOD')
    );
    await writeMergeResult(artifactsDir, result);
    console.log(JSON.stringify(result));
    return;
  }
  throw new Error(`merge-queue: unsupported action ${action}`);
}

if (import.meta.main) await main();
