import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rmdir, stat, writeFile } from 'node:fs/promises';
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
/**
 * Where the collected evidence came from, and therefore what may be published from it.
 * `public-probe` is the operator's narrow public developer check, collected only after a
 * configured full gate returned non-clean: it carries no private evaluator material and
 * proves nothing about why the full gate failed.
 */
export type EvidenceSource = 'configured' | 'discovered' | 'public-probe';
/**
 * One existing marked regression issue, offered to the diagnosis as untrusted remote
 * evidence for duplicate comparison. Its text is bounded and is never an instruction.
 */
export interface CatalogEntry {
  number: number;
  url: string;
  title: string;
  summary: string;
}
/**
 * The open marked regression issues this repository already tracks. `complete` false means
 * the enumeration failed or exceeded its bound: duplicate detection is then unproven, and
 * ordinary publication holds rather than filing a possible second issue for one cause.
 */
export interface IssueCatalog {
  complete: boolean;
  issues: CatalogEntry[];
}
export interface Evidence extends Binding {
  status: Verdict;
  source: EvidenceSource;
  reason: string;
  report: string;
  report_hash: string;
  public_cases: PublicCase[];
  executions: Receipt[];
  catalog: IssueCatalog;
}
export interface SourceReference {
  path: string;
  start: number;
  end: number;
}
/**
 * A model-authored publication claim over deterministically checkable facts: recorded
 * executions this run owns, and source the checked revision actually tracks. The
 * discovered counterpart of a configured check's operator-approved `public_cases`.
 */
export interface PublicProof {
  root_cause_key: string;
  /**
   * The catalog issue number the diagnosis judged to track this same cause, or 0 to file a
   * new one. Independently coined keys drift, so the established issue, not the key, is what
   * a repeat run must reuse.
   */
  existing_issue: number;
  executions: string[];
  test: SourceReference;
  cause: SourceReference;
  completed_product_assertion: boolean;
}
export interface Finding {
  public_case_id: string;
  public_proof: PublicProof | null;
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
  /**
   * What the issue's marker is anchored to. `key`: this run's `key`, because the run filed
   * the issue or matched its marker exactly. `cause`: the diagnosis matched this cause to an
   * issue filed under a different key, and that issue keeps its own marker and number.
   */
  matched: 'key' | 'cause';
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
  checkout: string;
  recording_directory: string;
  validation_scope: string;
  /** The operator authorized a public probe of a configured profile's non-clean full gate. */
  probe: boolean;
  /** The public scope a probe answers for. The configured `scope` stays with the private gate. */
  probe_scope: string;
}
/** Whether archon-validate runs at all, and the only scope text it may receive. */
export interface Routing {
  validate: boolean;
  scope: string;
}
/**
 * Proof that one validation command actually ran against the checked revision.
 * Command output is deliberately absent: the recorder streams it to the agent and
 * archon-validate's own report keeps the decisive tails, so nothing here can carry a
 * private stream into evidence, a prompt, or an issue.
 */
export interface Receipt extends Binding {
  id: string;
  argv: string[];
  checkout: string;
  intact: boolean;
  exit_code: number | null;
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
/** Stable lowercase cause identity: the dedup key survives revisions, scopes, and reruns. */
const MACHINE_KEY = /^[a-z0-9][a-z0-9._/-]{0,199}$/;
const REPOSITORY_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
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
/**
 * The scope archon-validate receives for ordinary discovery. It keeps the operator's
 * narrowing and adds the execution-recording requirement, because regress cannot widen a
 * neighboring pack's declared inputs to carry one.
 */
export function recordingScope(scope: string, recorder: string): string {
  return (
    `${scope || "The project's full applicable gate."}\n\n` +
    'Record every command you run for this gate. Instead of running a command directly, run ' +
    `\`bun ${JSON.stringify(recorder)} --record <command> [args...]\`. The recorder runs the command ` +
    'in the checkout, streams its output unchanged, exits with its status, and saves an execution ' +
    'receipt beside itself.\n\n' +
    'Those receipts are the only proof this gate ran: a command run without them leaves no evidence ' +
    'and cannot support a verdict, green or red. Never write or edit a receipt file yourself. Keep ' +
    'tracked files unchanged, because a command that modifies tracked source invalidates its own receipt, ' +
    'and keep destructive checks off live resources.'
  );
}
/**
 * The context a public probe works under. A probe answers for the public scope the operator
 * authorized, so that is the scope its receipts are stamped with and the scope its evidence,
 * investigation, and diagnosis are bound to. The configured profile's own scope is private
 * gate material and reaches none of them.
 */
export function publicContext(context: Prepared): Prepared {
  return context.probe ? { ...context, scope: context.probe_scope } : context;
}
export async function prepare(
  scope: string,
  policy: string,
  publicProbeScope: string,
  artifacts: string,
  base: string
): Promise<Prepared> {
  const directory = join(artifacts, 'regress');
  await mkdir(directory, { recursive: true });
  const probe = Boolean(policy) && Boolean(publicProbeScope);
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
    checkout: '',
    recording_directory: '',
    validation_scope: '',
    probe,
    probe_scope: probe ? publicProbeScope : '',
  };
  try {
    Object.assign(result, await binding(scope, base));
    if (!(await intact(result)))
      throw new Error('Tracked checkout changes prevent revision-bound validation');
    if (policy) result.profile_hash = (await profile(policy)).digest;
    result.checkout = await realpath(await git(['rev-parse', '--show-toplevel']));
    if (!policy || probe) {
      result.recording_directory = await mkdtemp(join(directory, 'recordings-'));
      // A copy, not the checkout's own script path: the recorder must keep working after
      // this run's materialized workflow source is gone, and it locates its context and
      // writes its receipts beside itself.
      const recorder = join(result.recording_directory, 'record.ts');
      await writeFile(recorder, await readFile(import.meta.path, 'utf8'));
      // A probe carries only the operator's public scope; the configured profile's own
      // scope belongs to the private gate and never reaches archon-validate.
      result.validation_scope = recordingScope(policy ? publicProbeScope : scope, recorder);
    }
    result.ready = true;
    if (result.recording_directory)
      await writeFile(
        join(result.recording_directory, 'prepared.json'),
        JSON.stringify(publicContext(result))
      );
  } catch (error) {
    result.reason = error instanceof Error ? error.message : String(error);
  }
  return result;
}
/**
 * Run one validation command in the checkout and leave a receipt beside this script.
 * The child owns the console and the exit status so recording stays invisible to the
 * agent's own workflow; only the receipt is added.
 */
async function recordExecution(argv: string[]): Promise<number> {
  if (argv.length === 0) throw new Error('Recording needs a command to run');
  const directory = import.meta.dir;
  const context = readPrepared(parse(await readFile(join(directory, 'prepared.json'), 'utf8')));
  process.chdir(context.checkout);
  const child = Bun.spawn(argv, { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' });
  const status = await child.exited;
  const completed = child.signalCode ? null : status;
  try {
    const receipt: Receipt = {
      ...(await binding(context.scope, context.base)),
      id: randomUUID(),
      argv,
      checkout: await realpath(await git(['rev-parse', '--show-toplevel'])),
      intact: await intact(context),
      exit_code: completed,
    };
    await writeFile(join(directory, `receipt-${receipt.id}.json`), JSON.stringify(receipt));
  } catch (error) {
    // Never mask the command's own result: report the lost receipt and let the missing
    // proof make the evidence inconclusive downstream.
    console.error(
      `Execution receipt was not written: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return completed ?? 1;
}
function readReceipt(value: unknown): Receipt {
  const row = object(value);
  if (
    typeof row.intact !== 'boolean' ||
    (row.exit_code !== null && !Number.isInteger(row.exit_code))
  ) {
    throw new Error('Invalid execution receipt');
  }
  return {
    ...readBinding(row),
    id: text(row.id),
    argv: strings(row.argv),
    checkout: text(row.checkout),
    intact: row.intact,
    exit_code: row.exit_code as number | null,
  };
}
async function receipts(context: Prepared): Promise<Receipt[]> {
  if (!context.recording_directory) return [];
  const names = (await readdir(context.recording_directory))
    .filter(name => name.startsWith('receipt-') && name.endsWith('.json'))
    .sort();
  const collected = await Promise.all(
    names.map(async name =>
      readReceipt(parse(await readFile(join(context.recording_directory, name), 'utf8')))
    )
  );
  if (new Set(collected.map(row => row.id)).size !== collected.length)
    throw new Error('Duplicate execution receipt identity');
  return collected;
}
function publicCase(value: unknown): PublicCase {
  const row = object(value);
  const id = text(row.id);
  const key = text(row.root_cause_key);
  if (!MACHINE_KEY.test(id) || !MACHINE_KEY.test(key)) {
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
function emptyEvidence(context: Prepared, reason: string, source: EvidenceSource): Evidence {
  return {
    revision: context.revision,
    base: context.base,
    base_revision: context.base_revision,
    scope: context.scope,
    source,
    status: 'inconclusive',
    reason,
    report: '',
    report_hash: '',
    public_cases: [],
    executions: [],
    catalog: { complete: false, issues: [] },
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
    'Configured check supplied no usable revision-bound evidence',
    'configured'
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
      'Configured evidence is absent, malformed, or has ambiguous public cases',
      'configured'
    );
  }
}
export async function configured(context: Prepared, policy: string): Promise<Evidence> {
  try {
    const selected = await profile(policy);
    if (selected.digest !== context.profile_hash)
      return emptyEvidence(context, 'Policy changed after preparation', 'configured');
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
      return emptyEvidence(context, 'Checkout changed during configured validation', 'configured');
    return configuredEvidence(context, execution, raw, report);
  } catch {
    return emptyEvidence(
      context,
      'Configured check could not start or collect evidence; inspect policy and environment',
      'configured'
    );
  }
}
export function discoveredEvidence(
  context: Prepared,
  verdict: unknown,
  raw: string,
  report: string,
  executions: Receipt[],
  source: EvidenceSource
): Evidence {
  const result = emptyEvidence(
    context,
    'Ordinary validation has no usable artifact or verdict',
    source
  );
  if (!raw.trim()) return result;
  if (executions.length === 0) {
    result.reason = 'Ordinary validation recorded no command execution, so the gate is unproven';
    return result;
  }
  if (
    executions.some(
      row => !row.intact || row.checkout !== context.checkout || !sameBinding(context, { ...row })
    )
  ) {
    result.reason = 'Recorded executions are not bound to this revision and an intact checkout';
    return result;
  }
  const value = object(verdict);
  result.report = report;
  result.report_hash = hash(raw);
  result.executions = executions;
  if (
    value.green === true &&
    value.red_cause === '' &&
    executions.every(row => row.exit_code === 0)
  ) {
    result.status = 'clean';
    result.reason =
      'Every recorded command completed successfully; scope coverage remains model judgment';
  } else if (
    value.green === false &&
    (value.red_cause === 'introduced' || value.red_cause === 'inherited') &&
    executions.some(row => row.exit_code !== null && row.exit_code !== 0)
  ) {
    result.status = 'product';
    result.reason =
      'Model classified product-red over a completed failing command; investigation must establish the causal chain';
  } else {
    result.reason = 'Validation is environmental, unrunnable, or unclassified';
  }
  return result;
}
/**
 * Collect what archon-validate actually produced: its artifact, this run's execution
 * receipts, and its own green/cause claim. Both routes that reach archon-validate share
 * it, so a public probe is held to exactly the proof an ordinary discovery must supply.
 */
async function recorded(
  context: Prepared,
  verdict: unknown,
  artifacts: string,
  source: EvidenceSource
): Promise<Evidence> {
  const produced = join(artifacts, 'validation.md');
  let executions: Receipt[];
  try {
    executions = await receipts(context);
  } catch {
    return emptyEvidence(
      context,
      'Execution receipts are unreadable, malformed, or ambiguous',
      source
    );
  }
  try {
    if ((await stat(produced)).mtimeMs < context.started)
      return emptyEvidence(context, 'Validation artifact predates this check', source);
    const raw = await readFile(produced, 'utf8');
    const report = join(context.directory, 'validation.md');
    await writeFile(report, raw);
    return discoveredEvidence(context, verdict, raw, report, executions, source);
  } catch {
    return emptyEvidence(
      context,
      'Validation artifact or verdict is missing or unreadable',
      source
    );
  }
}
/**
 * The public probe's evidence, built from nothing the configured gate produced. A green or
 * unavailable probe cannot answer for the full gate, so it keeps that gate's refusal rather
 * than reporting a clean run. Only a proven public product failure travels onward, and it
 * never claims to explain why the private gate failed.
 */
async function probeEvidence(
  context: Prepared,
  verdict: unknown,
  artifacts: string
): Promise<Evidence> {
  const result = await recorded(context, verdict, artifacts, 'public-probe');
  if (result.status === 'product') return result;
  return emptyEvidence(
    context,
    'The configured full gate was not clean and the public probe proved no public product ' +
      `defect: ${result.reason}`,
    'public-probe'
  );
}
async function collected(
  context: Prepared,
  verdict: unknown,
  fixed: unknown,
  artifacts: string
): Promise<Evidence> {
  if (!context.ready) return emptyEvidence(context, context.reason, context.mode);
  if (!(await intact(context)))
    return emptyEvidence(context, 'Checkout changed after evidence preparation', context.mode);
  if (context.mode === 'discovered') return recorded(context, verdict, artifacts, 'discovered');
  const gate = readEvidence(fixed);
  if (gate.status === 'clean' || !context.probe) return gate;
  return probeEvidence(publicContext(context), verdict, artifacts);
}
/**
 * Collect the evidence, and for an authorized ordinary publication the issues this
 * repository already tracks for earlier regressions. A trusted profile owns stable keys and
 * needs no catalog; an independently coined discovery key does not, so its diagnosis is the
 * stage that decides whether a proven cause already has an issue.
 */
async function collect(
  context: Prepared,
  verdict: unknown,
  fixed: unknown,
  artifacts: string,
  authorized: boolean
): Promise<Evidence> {
  const evidence = await collected(context, verdict, fixed, artifacts);
  if (!authorized || evidence.status !== 'product' || evidence.source === 'configured')
    return evidence;
  return { ...evidence, catalog: await issueCatalog(await originRepository(), runCommand) };
}
/**
 * Decide whether archon-validate runs and with what scope. The configured full gate is
 * mandatory and answered first; a probe follows only when the operator authorized one and
 * that gate came back non-clean. Nothing the gate reported crosses into the returned scope.
 */
export function route(context: Prepared, fixed: unknown): Routing {
  const skip: Routing = { validate: false, scope: '' };
  const run: Routing = { validate: true, scope: context.validation_scope };
  if (!context.ready) return skip;
  if (context.mode === 'discovered') return run;
  if (!context.probe) return skip;
  try {
    return readEvidence(fixed).status === 'clean' ? skip : run;
  } catch {
    // Unreadable configured evidence already fails the collector; spending a probe on it
    // would only add a second failure.
    return skip;
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
    checkout: typeof row.checkout === 'string' ? row.checkout : '',
    recording_directory: typeof row.recording_directory === 'string' ? row.recording_directory : '',
    validation_scope: typeof row.validation_scope === 'string' ? row.validation_scope : '',
    probe: row.probe === true,
    probe_scope: typeof row.probe_scope === 'string' ? row.probe_scope : '',
  };
}
function readCatalogEntry(value: unknown): CatalogEntry {
  const row = object(value);
  if (!Number.isInteger(row.number) || Number(row.number) < 1)
    throw new Error('A catalog entry needs a positive issue number');
  if (typeof row.title !== 'string' || typeof row.summary !== 'string')
    throw new Error('A catalog entry needs text fields');
  return { number: Number(row.number), url: text(row.url), title: row.title, summary: row.summary };
}
function readCatalog(value: unknown): IssueCatalog {
  if (value === undefined) return { complete: false, issues: [] };
  const row = object(value);
  if (typeof row.complete !== 'boolean' || !Array.isArray(row.issues))
    throw new Error('Invalid existing-issue catalog');
  return { complete: row.complete, issues: row.issues.map(readCatalogEntry) };
}
export function readEvidence(value: unknown): Evidence {
  const row = object(value);
  if (
    (row.status !== 'clean' && row.status !== 'product' && row.status !== 'inconclusive') ||
    (row.source !== 'configured' &&
      row.source !== 'discovered' &&
      row.source !== 'public-probe') ||
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
    executions: Array.isArray(row.executions) ? row.executions.map(readReceipt) : [],
    catalog: readCatalog(row.catalog),
  };
}
function readReference(value: unknown): SourceReference {
  const row = object(value);
  const path = text(row.path);
  const { start, end } = row;
  if (!REPOSITORY_PATH.test(path) || path.split('/').includes('..'))
    throw new Error('A public proof reference must be a repository-relative path');
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    Number(start) < 1 ||
    Number(end) < Number(start)
  ) {
    throw new Error('A public proof line range must be ordered positive integers');
  }
  return { path, start: Number(start), end: Number(end) };
}
/**
 * An empty `root_cause_key` is the declared absent form: the schema's `required` cannot
 * omit a property (OpenAI strict mode), so absence lives in the value like validate's
 * `red_cause`. Absent means this finding stays local, never that publication is blocked.
 */
function readProof(value: unknown): PublicProof | null {
  const row = object(value);
  if (typeof row.root_cause_key !== 'string') throw new Error('Missing proof root_cause_key');
  if (row.root_cause_key === '') return null;
  if (!MACHINE_KEY.test(row.root_cause_key))
    throw new Error('A public proof root cause key must be a stable lowercase machine key');
  if (typeof row.completed_product_assertion !== 'boolean')
    throw new Error('Missing completed_product_assertion');
  if (!Number.isInteger(row.existing_issue) || Number(row.existing_issue) < 0)
    throw new Error('A public proof names an existing issue number, or zero for none');
  return {
    root_cause_key: row.root_cause_key,
    existing_issue: Number(row.existing_issue),
    executions: strings(row.executions),
    test: readReference(row.test),
    cause: readReference(row.cause),
    completed_product_assertion: row.completed_product_assertion,
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
      public_proof: readProof(finding.public_proof),
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
/** Every issue this workflow has ever filed opens with a marker built from this prefix. */
const MARKER = '<!-- archon-regress:';
/** The publication destination, or null when the origin is not a github.com repository. */
async function originRepository(): Promise<string | null> {
  const remote = await runCommand(['git', 'remote', 'get-url', 'origin']);
  return remote.exitCode === 0 ? githubRepository(remote.stdout.trim()) : null;
}
export function issueMarker(repository: string, key: string): string {
  return `${MARKER}${hash(`${repository.toLowerCase()}\n${key}`)} -->`;
}
export function issueBody(repository: string, candidate: PublicCase, revision: string): string {
  return (
    `${issueMarker(repository, candidate.root_cause_key)}\n\n` +
    `## Problem\n\n${candidate.actual}\n\n## Expected behavior\n\n${candidate.expected}\n\n` +
    `## Root cause\n\n${candidate.root_cause}\n\n## Reproduction\n\n${candidate.reproduction}\n\n` +
    `## Evidence\n\n${candidate.evidence.map(item => `- ${item}`).join('\n')}\n\nObserved revision: ${revision}\n`
  );
}
interface RemoteIssue {
  number: number;
  url: string;
  body: string;
  title: string;
  state: 'open' | 'closed';
}
function issue(value: unknown, repository: string): RemoteIssue {
  const row = object(value);
  if (
    row.pull_request ||
    !Number.isInteger(row.number) ||
    Number(row.number) < 1 ||
    (typeof row.body !== 'string' && row.body !== null) ||
    typeof row.title !== 'string' ||
    (row.state !== 'open' && row.state !== 'closed') ||
    typeof row.html_url !== 'string' ||
    row.html_url.toLowerCase() !== `https://github.com/${repository}/issues/${row.number}`
  )
    throw new Error('GitHub returned an invalid issue');
  return {
    number: Number(row.number),
    url: row.html_url,
    body: row.body ?? '',
    title: row.title,
    state: row.state,
  };
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
/**
 * Every marked regression issue this repository tracks, lowest number first. It lists all
 * states through REST instead of search, because indexing lag must never authorize a create,
 * and a failed query throws rather than becoming an empty result.
 */
async function markedIssues(repository: string, run: RunCommand): Promise<RemoteIssue[]> {
  const pages = await api(run, [
    `repos/${repository}/issues?state=all&per_page=100`,
    '--paginate',
    '--slurp',
  ]);
  if (!Array.isArray(pages) || !pages.every(Array.isArray))
    throw new Error('GitHub issue listing was not paginated JSON');
  return pages
    .flat()
    .filter((value: unknown) => !object(value).pull_request)
    .map((value: unknown) => issue(value, repository))
    .filter(value => value.body.includes(MARKER))
    .sort((a, b) => a.number - b.number);
}
/**
 * How many marked issues can be compared at once. Past it the catalog is not a complete
 * picture of what the repository already tracks, so ordinary publication holds instead of
 * claiming a cause is new.
 */
const CATALOG_LIMIT = 100;
const SUMMARY_LIMIT = 300;
/** Untrusted remote text, bounded for comparison: markers stripped, whitespace collapsed. */
function excerpt(body: string): string {
  const collapsed = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return collapsed.length > SUMMARY_LIMIT ? `${collapsed.slice(0, SUMMARY_LIMIT)}…` : collapsed;
}
/**
 * The open marked issues a diagnosis may reuse. Closed issues are excluded: a closed
 * duplicate or a fixed defect is not an actionable existing defect to attach a new
 * occurrence to. An unavailable, malformed, or over-bound listing yields an incomplete
 * catalog, which holds publication rather than passing off partial knowledge as complete.
 */
export async function issueCatalog(
  repository: string | null,
  run: RunCommand
): Promise<IssueCatalog> {
  if (!repository) return { complete: false, issues: [] };
  try {
    const open = (await markedIssues(repository, run)).filter(row => row.state === 'open');
    if (open.length > CATALOG_LIMIT) return { complete: false, issues: [] };
    return {
      complete: true,
      issues: open.map(row => ({
        number: row.number,
        url: row.url,
        title: row.title,
        summary: excerpt(row.body),
      })),
    };
  } catch {
    return { complete: false, issues: [] };
  }
}
/** A publishable case and the existing issue, if any, the diagnosis matched its cause to. */
export interface Candidate {
  publication: PublicCase;
  existing: number;
}
async function publishCases(
  repository: string,
  candidates: Candidate[],
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
    for (const candidate of candidates) {
      const marker = issueMarker(repository, candidate.publication.root_cause_key);
      const marked = await markedIssues(repository, run);
      const keyed = marked.filter(value => value.body.includes(marker));
      // The canonical issue for a key is its lowest open one. A closed issue with that key is
      // still reported rather than duplicated: recurrence after a close is an operator call.
      let found: RemoteIssue | undefined = keyed.find(value => value.state === 'open') ?? keyed[0];
      let matched: IssueReference['matched'] = 'key';
      if (!found && candidate.existing > 0) {
        found = marked.find(
          value => value.number === candidate.existing && value.state === 'open'
        );
        if (!found)
          throw new Error(
            'The diagnosis matched a cause to an issue that is not an open marked regression issue'
          );
        matched = 'cause';
      }
      const disposition = found ? 'existing' : 'created';
      const body = issueBody(repository, candidate.publication, revision);
      if (!found)
        found = issue(
          await api(run, [`repos/${repository}/issues`, '--method', 'POST', '--input', '-'], {
            title: candidate.publication.title,
            body,
          }),
          repository
        );
      const reference: IssueReference = {
        key: candidate.publication.root_cause_key,
        number: found.number,
        url: found.url,
        disposition,
        matched,
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
        // A cause match inherits the issue's own marker, so only its regress identity and its
        // open state can be re-checked; a key match and a create own the exact marker.
        !readback.body.includes(matched === 'cause' ? MARKER : marker) ||
        (matched === 'cause' && readback.state !== 'open') ||
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

export type VerifyReference = (
  reference: SourceReference,
  revision: string
) => Promise<boolean>;
/** A public proof may only name source the checked revision actually tracks. */
export function referenceVerifier(checkout: string, run: RunCommand = runCommand): VerifyReference {
  return async (reference, revision) => {
    if (!checkout) return false;
    const blob = await run(['git', '-C', checkout, 'cat-file', 'blob', `${revision}:${reference.path}`]);
    if (blob.exitCode !== 0) return false;
    const lines = blob.stdout.split('\n');
    return reference.end <= (lines.at(-1) === '' ? lines.length - 1 : lines.length);
  };
}
function located(reference: SourceReference): string {
  return `${reference.path}:${reference.start}-${reference.end}`;
}
/**
 * Turn one ordinary-discovery finding into a publishable case, or nothing. The model owns
 * the words; this owns the prerequisites: a recorded command that ran to a failing exit
 * under this run's binding, and source the checked revision tracks at the cited lines.
 */
async function discoveredCase(
  evidence: Evidence,
  finding: Finding,
  verify: VerifyReference
): Promise<PublicCase | null> {
  const proof = finding.public_proof;
  if (!proof?.completed_product_assertion) return null;
  const cited: Receipt[] = [];
  for (const id of proof.executions) {
    const receipt = evidence.executions.find(row => row.id === id);
    if (!receipt) return null;
    cited.push(receipt);
  }
  if (!cited.some(row => row.exit_code !== null && row.exit_code !== 0)) return null;
  if (!(await verify(proof.test, evidence.revision))) return null;
  if (!(await verify(proof.cause, evidence.revision))) return null;
  return {
    id: proof.root_cause_key,
    root_cause_key: proof.root_cause_key,
    title: finding.title,
    root_cause: finding.root_cause,
    expected: finding.expected,
    actual: finding.actual,
    reproduction: finding.reproduction,
    evidence: [
      ...finding.evidence,
      `Failing assertion: ${located(proof.test)}`,
      `Source-owned cause: ${located(proof.cause)}`,
    ],
  };
}
/**
 * Every finding's publishable case, or null when any one of them lacks distinct evidence.
 * Two findings may not share a cause identity, and may not be matched to the same existing
 * issue: separate causes that happen to live in one file stay separate defects.
 */
async function publicationCases(
  evidence: Evidence,
  diagnosis: Diagnosis,
  verify: VerifyReference
): Promise<Candidate[] | null> {
  const candidates: Candidate[] = [];
  for (const finding of diagnosis.findings) {
    const publication =
      evidence.source === 'configured'
        ? (evidence.public_cases.find(row => row.id === finding.public_case_id) ?? null)
        : await discoveredCase(evidence, finding, verify);
    if (!publication) return null;
    candidates.push({
      publication,
      // A trusted profile's key is stable by construction, so its route stays key-identified.
      existing: evidence.source === 'configured' ? 0 : (finding.public_proof?.existing_issue ?? 0),
    });
  }
  if (candidates.length === 0) return null;
  const reused = candidates.map(row => row.existing).filter(number => number > 0);
  if (new Set(reused).size !== reused.length) return null;
  return new Set(candidates.map(row => row.publication.root_cause_key)).size === candidates.length
    ? candidates
    : null;
}
/**
 * Refuse a case that carries a local path into a public issue. It checks the two paths
 * this run knows are local, the checkout and the artifact directory, and is not a
 * secret detector: everything else rests on the trusted check author or the prompt.
 */
function local(candidate: PublicCase, paths: string[]): boolean {
  const fields = [
    candidate.title,
    candidate.root_cause,
    candidate.expected,
    candidate.actual,
    candidate.reproduction,
    ...candidate.evidence,
  ];
  return paths.some(path => path.length > 0 && fields.some(field => field.includes(path)));
}

export interface PublicationRequest {
  evidence: Evidence;
  diagnosis: Diagnosis;
  /** publish=true, the operator's explicit authorization to export this evidence. */
  authorized: boolean;
  repository: string | null;
  record: (issues: IssueReference[]) => Promise<void>;
  verify: VerifyReference;
  /** Local paths that must never reach an issue: the checkout and the artifact directory. */
  localPaths: string[];
  run?: RunCommand;
  lockRoot?: string;
}
export async function publish(
  request: PublicationRequest
): Promise<Pick<Result, 'publication' | 'publication_reason' | 'issues'>> {
  const result: Pick<Result, 'publication' | 'publication_reason' | 'issues'> = {
    publication: 'disabled',
    publication_reason: '',
    issues: [],
  };
  if (!request.authorized) return result;
  if (request.diagnosis.status !== 'defects') return { ...result, publication: 'not-applicable' };
  result.publication = 'blocked';
  // Evidence before destination: an operator whose evidence cannot be published learns
  // that, rather than hearing about a remote that was never the reason.
  if (request.evidence.status !== 'product')
    return {
      ...result,
      publication_reason: 'Publication needs product-red evidence bound to the checked revision',
    };
  const candidates = await publicationCases(request.evidence, request.diagnosis, request.verify);
  if (!candidates)
    return {
      ...result,
      publication_reason:
        'Every finding needs distinct public evidence: a trusted configured case, or a verified public proof over a recorded failing command and tracked source',
    };
  if (candidates.some(candidate => local(candidate.publication, request.localPaths)))
    return {
      ...result,
      publication_reason: 'Public evidence still carries a local checkout or artifact path',
    };
  if (!request.repository)
    return {
      ...result,
      publication_reason: 'Publication supports github.com origin repositories only',
    };
  // An independently coined key cannot carry identity by itself, so a discovery publishes
  // only against a complete picture of the issues this repository already tracks.
  if (request.evidence.source !== 'configured' && !request.evidence.catalog.complete)
    return {
      ...result,
      publication_reason:
        'Existing regression issues could not be enumerated completely, so this cause cannot be shown to be new; publication is held',
    };
  const outcome = await publishCases(
    request.repository,
    candidates,
    request.evidence.revision,
    request.run ?? runCommand,
    request.record,
    request.lockRoot
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
    return prepare(
      input('SCOPE'),
      input('POLICY'),
      input('PUBLIC_PROBE_SCOPE'),
      artifacts,
      process.env.BASE_BRANCH ?? ''
    );
  const context = readPrepared(parse(input('PREPARED')));
  if (phase === 'configured') return configured(context, input('POLICY'));
  if (phase === 'route') return route(context, parse(input('FIXED') || 'null'));
  if (phase === 'collect')
    return collect(
      context,
      parse(input('VALIDATION') || 'null'),
      parse(input('FIXED') || 'null'),
      artifacts,
      input('PUBLISH') === 'true'
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
      context.ready &&
      (!(await intact(context)) ||
        !sameBinding(
          evidence.source === 'public-probe' ? publicContext(context) : context,
          { ...evidence }
        ) ||
        (evidence.report && hash(await readFile(evidence.report, 'utf8')) !== evidence.report_hash))
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
  const repository =
    input('PUBLISH') === 'true' && diagnosis.status === 'defects' ? await originRepository() : null;
  const publication = await publish({
    evidence,
    diagnosis,
    authorized: input('PUBLISH') === 'true',
    repository,
    record: async issues => {
      await writeFile(join(context.directory, 'issues.json'), JSON.stringify(issues, null, 2));
    },
    verify: referenceVerifier(context.checkout),
    localPaths: [context.checkout, context.directory],
  });
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
    if (process.argv[2] === '--record') process.exitCode = await recordExecution(process.argv.slice(3));
    else console.log(JSON.stringify(await main()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Regression workflow contract failed');
    process.exitCode = 1;
  }
}
