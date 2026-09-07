import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

type ObjectValue = Record<string, unknown>;
type Verdict = 'clean' | 'product' | 'inconclusive';
export interface Binding {
  revision: string;
  base: string;
  base_revision: string;
  scope: string;
}
export interface PublicCase {
  id: string;
  root_cause_key: string;
  title: string;
  root_cause: string;
  expected: string;
  actual: string;
  reproduction: string;
  evidence: string[];
}
export interface Evidence extends Binding {
  status: Verdict;
  source: 'configured' | 'discovered';
  reason: string;
  report: string;
  report_hash: string;
  public_cases: PublicCase[];
}
export interface Finding {
  public_case_id: string;
  title: string;
  root_cause: string;
  expected: string;
  actual: string;
  reproduction: string;
  evidence: string[];
}
export interface Diagnosis {
  status: 'clean' | 'defects' | 'inconclusive';
  summary: string;
  findings: Finding[];
}
export interface IssueReference {
  key: string;
  number: number;
  url: string;
  disposition: 'existing' | 'created';
  verified: boolean;
}
export interface Result extends Diagnosis, Binding {
  publication: 'disabled' | 'not-applicable' | 'blocked' | 'published';
  publication_reason: string;
  issues: IssueReference[];
}
interface Profile {
  version: 1;
  argv: string[];
  timeout_seconds: number;
}
export interface Prepared extends Binding {
  ready: boolean;
  mode: 'configured' | 'discovered';
  reason: string;
  started: number;
  directory: string;
  profile_hash: string;
}
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}
export type RunCommand = (
  argv: string[],
  options?: { env?: NodeJS.ProcessEnv; timeout?: number; stdin?: string }
) => Promise<CommandResult>;

export function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object');
  }
  return value as ObjectValue;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected nonempty text');
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Expected nonempty text list');
  return value.map(text);
}
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function parse(value: string): unknown {
  return JSON.parse(value);
}
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}
export const runCommand: RunCommand = async (argv, options = {}) => {
  try {
    const child = Bun.spawn(argv, {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
      env: { ...process.env, ...options.env },
      timeout: options.timeout ?? 60_000,
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode: child.signalCode ? null : exitCode, stdout, stderr };
  } catch (error) {
    return {
      exitCode: null,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
};

async function git(args: string[]): Promise<string> {
  const result = await runCommand(['git', ...args]);
  if (result.exitCode !== 0)
    throw new Error('Git could not resolve the checkout or configured base');
  return result.stdout.trim();
}
async function binding(scope: string, base: string): Promise<Binding> {
  if (!base || base.startsWith('-')) throw new Error('A configured base branch is required');
  return {
    scope,
    base,
    revision: await git(['rev-parse', '--verify', 'HEAD^{commit}']),
    base_revision: await git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]),
  };
}
function sameBinding(left: Binding, right: ObjectValue): boolean {
  return (
    left.revision === right.revision &&
    left.base === right.base &&
    left.base_revision === right.base_revision &&
    left.scope === right.scope
  );
}
async function intact(expected: Binding): Promise<boolean> {
  return (
    sameBinding(expected, { ...(await binding(expected.scope, expected.base)) }) &&
    (await git(['status', '--porcelain', '--untracked-files=no'])) === ''
  );
}
async function profile(path: string): Promise<{ value: Profile; digest: string }> {
  if (!isAbsolute(path))
    throw new Error('Policy must be an absolute path to a trusted external JSON profile');
  const actual = await realpath(path);
  const checkout = await realpath(await git(['rev-parse', '--show-toplevel']));
  if (inside(checkout, actual)) throw new Error('Policy must be outside the source checkout');
  const raw = await readFile(actual, 'utf8');
  const value = object(parse(raw));
  if (
    value.version !== 1 ||
    typeof value.timeout_seconds !== 'number' ||
    !Number.isInteger(value.timeout_seconds) ||
    value.timeout_seconds < 1 ||
    value.timeout_seconds > 3600
  ) {
    throw new Error('Invalid policy version or timeout_seconds (1..3600)');
  }
  return {
    value: { version: 1, argv: strings(value.argv), timeout_seconds: value.timeout_seconds },
    digest: hash(raw),
  };
}
export async function prepare(
  scope: string,
  policy: string,
  artifacts: string,
  base: string
): Promise<Prepared> {
  const directory = join(artifacts, 'regress');
  await mkdir(directory, { recursive: true });
  const result: Prepared = {
    revision: '',
    base,
    base_revision: '',
    scope,
    ready: false,
    mode: policy ? 'configured' : 'discovered',
    reason: '',
    started: Date.now(),
    directory,
    profile_hash: '',
  };
  try {
    Object.assign(result, await binding(scope, base));
    if (!(await intact(result)))
      throw new Error('Tracked checkout changes prevent revision-bound validation');
    if (policy) result.profile_hash = (await profile(policy)).digest;
    result.ready = true;
  } catch (error) {
    result.reason = error instanceof Error ? error.message : String(error);
  }
  return result;
}
function publicCase(value: unknown): PublicCase {
  const row = object(value);
  const id = text(row.id);
  const key = text(row.root_cause_key);
  if (!/^[a-z0-9][a-z0-9._/-]{0,199}$/.test(id) || !/^[a-z0-9][a-z0-9._/-]{0,199}$/.test(key)) {
    throw new Error('Public case identifiers must be stable lowercase machine keys');
  }
  return {
    id,
    root_cause_key: key,
    title: text(row.title),
    root_cause: text(row.root_cause),
    expected: text(row.expected),
    actual: text(row.actual),
    reproduction: text(row.reproduction),
    evidence: strings(row.evidence),
  };
}
function emptyEvidence(context: Prepared, reason: string): Evidence {
  return {
    revision: context.revision,
    base: context.base,
    base_revision: context.base_revision,
    scope: context.scope,
    source: context.mode,
    status: 'inconclusive',
    reason,
    report: '',
    report_hash: '',
    public_cases: [],
  };
}
export function configuredEvidence(
  context: Prepared,
  execution: CommandResult,
  raw: string,
  report: string
): Evidence {
  const result = emptyEvidence(
    context,
    'Configured check supplied no usable revision-bound evidence'
  );
  try {
    const value = object(parse(raw));
    if (!sameBinding(context, value) || execution.exitCode === null) return result;
    if (value.status !== 'clean' && value.status !== 'product' && value.status !== 'inconclusive')
      return result;
    if (
      (value.status === 'clean' && execution.exitCode !== 0) ||
      (value.status === 'product' && execution.exitCode === 0)
    )
      return result;
    result.status = value.status;
    result.reason = 'Trusted configured check evidence collected';
    result.report = report;
    result.report_hash = hash(raw);
    if (!Array.isArray(value.public_cases)) throw new Error('Expected public_cases array');
    result.public_cases = value.public_cases.map(publicCase);
    if (
      new Set(result.public_cases.map(row => row.id)).size !== result.public_cases.length ||
      new Set(result.public_cases.map(row => row.root_cause_key)).size !==
        result.public_cases.length
    ) {
      throw new Error('Duplicate public case identity');
    }
    return result;
  } catch {
    return emptyEvidence(
      context,
      'Configured evidence is absent, malformed, or has ambiguous public cases'
    );
  }
}
export async function configured(context: Prepared, policy: string): Promise<Evidence> {
  try {
    const selected = await profile(policy);
    if (selected.digest !== context.profile_hash)
      return emptyEvidence(context, 'Policy changed after preparation');
    // A fresh destination prevents an old successful check report surviving a failed startup.
    const directory = await mkdtemp(join(context.directory, 'check-'));
    const report = join(directory, 'evidence.json');
    const execution = await runCommand(selected.value.argv, {
      timeout: selected.value.timeout_seconds * 1000,
      env: {
        REGRESS_EVIDENCE_PATH: report,
        REGRESS_REVISION: context.revision,
        REGRESS_BASE: context.base,
        REGRESS_BASE_REVISION: context.base_revision,
        REGRESS_SCOPE: context.scope,
      },
    });
    await writeFile(join(directory, 'private-execution.json'), JSON.stringify(execution));
    const raw = await readFile(report, 'utf8').catch(() => '');
    if (!(await intact(context)))
      return emptyEvidence(context, 'Checkout changed during configured validation');
    return configuredEvidence(context, execution, raw, report);
  } catch {
    return emptyEvidence(
      context,
      'Configured check could not start or collect evidence; inspect policy and environment'
    );
  }
}
export function discoveredEvidence(
  context: Prepared,
  verdict: unknown,
  raw: string,
  report: string
): Evidence {
  const result = emptyEvidence(context, 'Ordinary validation has no usable artifact or verdict');
  if (!raw.trim()) return result;
  const value = object(verdict);
  result.report = report;
  result.report_hash = hash(raw);
  if (value.green === true && value.red_cause === '') {
    result.status = 'clean';
    result.reason =
      'Model verdict backed by collected validation.md; not a deterministic check attestation';
  } else if (
    value.green === false &&
    (value.red_cause === 'introduced' || value.red_cause === 'inherited')
  ) {
    result.status = 'product';
    result.reason = 'Model classified product-red; investigation must establish the causal chain';
  } else {
    result.reason = 'Validation is environmental, unrunnable, or unclassified';
  }
  return result;
}
async function collect(
  context: Prepared,
  verdict: unknown,
  fixed: unknown,
  artifacts: string
): Promise<Evidence> {
  if (!context.ready) return emptyEvidence(context, context.reason);
  if (!(await intact(context)))
    return emptyEvidence(context, 'Checkout changed after evidence preparation');
  if (context.mode === 'configured') return readEvidence(fixed);
  const source = join(artifacts, 'validation.md');
  try {
    if ((await stat(source)).mtimeMs < context.started)
      return emptyEvidence(context, 'Validation artifact predates this check');
    const raw = await readFile(source, 'utf8');
    const report = join(context.directory, 'validation.md');
    await writeFile(report, raw);
    return discoveredEvidence(context, verdict, raw, report);
  } catch {
    return emptyEvidence(context, 'Validation artifact or verdict is missing or unreadable');
  }
}
function readBinding(value: ObjectValue): Binding {
  if (
    typeof value.scope !== 'string' ||
    typeof value.revision !== 'string' ||
    typeof value.base !== 'string' ||
    typeof value.base_revision !== 'string'
  )
    throw new Error('Missing evidence binding');
  return {
    revision: value.revision,
    base: value.base,
    base_revision: value.base_revision,
    scope: value.scope,
  };
}
function readPrepared(value: unknown): Prepared {
  const row = object(value);
  if (
    typeof row.ready !== 'boolean' ||
    (row.mode !== 'configured' && row.mode !== 'discovered') ||
    typeof row.reason !== 'string' ||
    typeof row.started !== 'number' ||
    typeof row.profile_hash !== 'string'
  ) {
    throw new Error('Invalid preparation result');
  }
  return {
    ...readBinding(row),
    ready: row.ready,
    mode: row.mode,
    reason: row.reason,
    started: row.started,
    profile_hash: row.profile_hash,
    directory: text(row.directory),
  };
}
function readEvidence(value: unknown): Evidence {
  const row = object(value);
  if (
    (row.status !== 'clean' && row.status !== 'product' && row.status !== 'inconclusive') ||
    (row.source !== 'configured' && row.source !== 'discovered') ||
    typeof row.report !== 'string' ||
    typeof row.report_hash !== 'string' ||
    !Array.isArray(row.public_cases)
  ) {
    throw new Error('Invalid collected evidence');
  }
  return {
    ...readBinding(row),
    status: row.status,
    source: row.source,
    reason: text(row.reason),
    report: row.report,
    report_hash: row.report_hash,
    public_cases: row.public_cases.map(publicCase),
  };
}
export function readDiagnosis(value: unknown): Diagnosis {
  const row = object(value);
  if (row.status !== 'clean' && row.status !== 'defects' && row.status !== 'inconclusive')
    throw new Error('Invalid diagnosis');
  if (!Array.isArray(row.findings)) throw new Error('Missing findings');
  const findings = row.findings.map((item: unknown): Finding => {
    const finding = object(item);
    if (typeof finding.public_case_id !== 'string') throw new Error('Missing public_case_id');
    return {
      public_case_id: finding.public_case_id,
      title: text(finding.title),
      root_cause: text(finding.root_cause),
      expected: text(finding.expected),
      actual: text(finding.actual),
      reproduction: text(finding.reproduction),
      evidence: strings(finding.evidence),
    };
  });
  if ((row.status === 'defects') !== findings.length > 0)
    throw new Error('Diagnosis status and findings disagree');
  return { status: row.status, summary: text(row.summary), findings };
}
export function settle(
  evidence: Evidence,
  diagnosis: Diagnosis,
  rooted: boolean,
  hasInvestigation: boolean
): Diagnosis {
  if (evidence.status === 'clean' && diagnosis.status === 'clean') return diagnosis;
  if (evidence.status === 'product' && rooted && hasInvestigation && diagnosis.status === 'defects')
    return diagnosis;
  return {
    status: 'inconclusive',
    summary:
      evidence.status === 'inconclusive'
        ? evidence.reason
        : 'Evidence and diagnosis do not establish a clean result or a rooted product defect',
    findings: [],
  };
}

export function githubRepository(remote: string): string | null {
  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote);
  if (ssh) return ssh[1].toLowerCase();
  try {
    const url = new URL(remote);
    if (
      !['https:', 'ssh:'].includes(url.protocol) ||
      url.hostname !== 'github.com' ||
      url.port ||
      url.search ||
      url.hash
    )
      return null;
    const path = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path) ? path.toLowerCase() : null;
  } catch {
    return null;
  }
}
export function issueMarker(repository: string, key: string): string {
  return `<!-- archon-regress:${hash(`${repository.toLowerCase()}\n${key}`)} -->`;
}
export function issueBody(repository: string, candidate: PublicCase, revision: string): string {
  return (
    `${issueMarker(repository, candidate.root_cause_key)}\n\n` +
    `## Problem\n\n${candidate.actual}\n\n## Expected behavior\n\n${candidate.expected}\n\n` +
    `## Root cause\n\n${candidate.root_cause}\n\n## Reproduction\n\n${candidate.reproduction}\n\n` +
    `## Evidence\n\n${candidate.evidence.map(item => `- ${item}`).join('\n')}\n\nObserved revision: ${revision}\n`
  );
}
function issue(value: unknown, repository: string): { number: number; url: string; body: string } {
  const row = object(value);
  if (
    row.pull_request ||
    !Number.isInteger(row.number) ||
    Number(row.number) < 1 ||
    (typeof row.body !== 'string' && row.body !== null) ||
    typeof row.html_url !== 'string' ||
    row.html_url.toLowerCase() !== `https://github.com/${repository}/issues/${row.number}`
  )
    throw new Error('GitHub returned an invalid issue');
  return { number: Number(row.number), url: row.html_url, body: row.body ?? '' };
}
async function api(run: RunCommand, args: string[], input?: unknown): Promise<unknown> {
  const result = await run(
    ['gh', 'api', '--hostname', 'github.com', ...args],
    input === undefined ? {} : { stdin: JSON.stringify(input) }
  );
  if (result.exitCode !== 0)
    throw new Error('GitHub request failed; no empty-result fallback or automatic create retry');
  try {
    return parse(result.stdout);
  } catch {
    throw new Error('GitHub returned malformed JSON; publication stopped');
  }
}
export async function publishCases(
  repository: string,
  cases: PublicCase[],
  revision: string,
  run: RunCommand,
  record: (issues: IssueReference[]) => Promise<void>,
  lockRoot = tmpdir()
): Promise<{ issues: IssueReference[]; reason: string }> {
  const issues: IssueReference[] = [];
  const lock = join(lockRoot, `archon-regress-${hash(repository)}`);
  let acquired = false;
  try {
    await mkdir(lock);
    acquired = true;
    for (const candidate of cases) {
      const marker = issueMarker(repository, candidate.root_cause_key);
      // List all states through REST instead of search: indexing lag must not authorize a create.
      const pages = await api(run, [
        `repos/${repository}/issues?state=all&per_page=100`,
        '--paginate',
        '--slurp',
      ]);
      if (!Array.isArray(pages) || !pages.every(Array.isArray))
        throw new Error('GitHub issue listing was not paginated JSON');
      const matches = pages
        .flat()
        .filter((value: unknown) => !object(value).pull_request)
        .map((value: unknown) => issue(value, repository))
        .filter(value => value.body.includes(marker))
        .sort((a, b) => a.number - b.number);
      let found = matches[0];
      const disposition = found ? 'existing' : 'created';
      const body = issueBody(repository, candidate, revision);
      if (!found)
        found = issue(
          await api(run, [`repos/${repository}/issues`, '--method', 'POST', '--input', '-'], {
            title: candidate.title,
            body,
          }),
          repository
        );
      const reference: IssueReference = {
        key: candidate.root_cause_key,
        number: found.number,
        url: found.url,
        disposition,
        verified: false,
      };
      issues.push(reference);
      await record(issues);
      const readback = issue(
        await api(run, [`repos/${repository}/issues/${found.number}`]),
        repository
      );
      if (
        readback.number !== found.number ||
        !readback.body.includes(marker) ||
        (disposition === 'created' && readback.body !== body)
      )
        throw new Error('GitHub issue readback did not verify the published evidence');
      reference.verified = true;
      await record(issues);
    }
    return { issues, reason: '' };
  } catch (error) {
    return {
      issues,
      reason: acquired
        ? error instanceof Error
          ? error.message
          : 'Publication failed'
        : 'Publication lock is unavailable; another local publisher or an orphaned lock requires operator attention',
    };
  } finally {
    if (acquired) await rmdir(lock);
  }
}

export async function publish(
  evidence: Evidence,
  diagnosis: Diagnosis,
  authorized: boolean,
  repository: string | null,
  record: (issues: IssueReference[]) => Promise<void>,
  run: RunCommand = runCommand,
  lockRoot?: string
): Promise<Pick<Result, 'publication' | 'publication_reason' | 'issues'>> {
  const result: Pick<Result, 'publication' | 'publication_reason' | 'issues'> = {
    publication: 'disabled',
    publication_reason: '',
    issues: [],
  };
  if (!authorized) return result;
  if (diagnosis.status !== 'defects') return { ...result, publication: 'not-applicable' };
  result.publication = 'blocked';
  if (!repository)
    return {
      ...result,
      publication_reason: 'Publication supports github.com origin repositories only',
    };
  const cases = diagnosis.findings.map(finding =>
    evidence.public_cases.find(row => row.id === finding.public_case_id)
  );
  if (
    evidence.source !== 'configured' ||
    evidence.status !== 'product' ||
    cases.some(row => !row) ||
    new Set(cases.map(row => row?.root_cause_key)).size !== cases.length
  ) {
    return {
      ...result,
      publication_reason:
        'Every finding needs a distinct trusted public case from configured product evidence',
    };
  }
  const verifiedCases = cases.filter((row): row is PublicCase => row !== undefined);
  const outcome = await publishCases(
    repository,
    verifiedCases,
    evidence.revision,
    run,
    record,
    lockRoot
  );
  return {
    publication: outcome.reason ? 'blocked' : 'published',
    publication_reason: outcome.reason,
    issues: outcome.issues,
  };
}

async function main(): Promise<unknown> {
  const input = (name: string): string => process.env[`INPUTS_${name}`] ?? '';
  const artifacts = text(process.env.ARTIFACTS_DIR);
  const phase = input('PHASE');
  if (phase === 'prepare')
    return prepare(input('SCOPE'), input('POLICY'), artifacts, process.env.BASE_BRANCH ?? '');
  const context = readPrepared(parse(input('PREPARED')));
  if (phase === 'configured') return configured(context, input('POLICY'));
  if (phase === 'collect')
    return collect(
      context,
      parse(input('VALIDATION') || 'null'),
      parse(input('FIXED') || 'null'),
      artifacts
    );
  if (phase !== 'finish') throw new Error('Unknown regress phase');
  const evidence = readEvidence(parse(input('EVIDENCE')));
  let diagnosis: Diagnosis = { status: 'inconclusive', summary: evidence.reason, findings: [] };
  const investigation = parse(input('INVESTIGATION') || 'null');
  let hasInvestigation = false;
  try {
    const report = join(artifacts, 'investigation.md');
    hasInvestigation =
      (await stat(report)).mtimeMs >= context.started && !!(await readFile(report, 'utf8')).trim();
  } catch {
    /* A missing investigation is an inconclusive result, never a defect. */
  }
  try {
    diagnosis = settle(
      evidence,
      readDiagnosis(parse(input('DIAGNOSIS'))),
      investigation !== null && object(investigation).rooted === true,
      hasInvestigation
    );
    if (
      !(await intact(context)) ||
      !sameBinding(context, { ...evidence }) ||
      (evidence.report && hash(await readFile(evidence.report, 'utf8')) !== evidence.report_hash)
    ) {
      diagnosis = {
        status: 'inconclusive',
        summary: 'Checkout or collected evidence changed before publication',
        findings: [],
      };
    }
  } catch {
    diagnosis = {
      status: 'inconclusive',
      summary: 'Diagnosis or evidence is missing or malformed',
      findings: [],
    };
  }
  if (input('PUBLISH') !== 'true' && input('PUBLISH') !== 'false')
    throw new Error('publish must be true or false');
  let repository: string | null = null;
  if (input('PUBLISH') === 'true' && diagnosis.status === 'defects') {
    const remote = await runCommand(['git', 'remote', 'get-url', 'origin']);
    if (remote.exitCode === 0) repository = githubRepository(remote.stdout.trim());
  }
  const publication = await publish(
    evidence,
    diagnosis,
    input('PUBLISH') === 'true',
    repository,
    async issues => {
      await writeFile(join(context.directory, 'issues.json'), JSON.stringify(issues, null, 2));
    }
  );
  const result: Result = {
    ...diagnosis,
    revision: evidence.revision,
    base: evidence.base,
    base_revision: evidence.base_revision,
    scope: evidence.scope,
    ...publication,
  };
  await writeFile(join(context.directory, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}
if (import.meta.main) {
  try {
    console.log(JSON.stringify(await main()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Regression workflow contract failed');
    process.exitCode = 1;
  }
}
