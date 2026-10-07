// Required-check policy is a fact with one correct answer, so a script reads it
// and no agent decides it. GitHub answers 403 for rulesets and protection
// details on plans without those features, which is why a caller can declare
// the policy instead; an undeclared policy GitHub will not report is unknown,
// never assumed to be "none".

type JsonObject = Record<string, unknown>;
type CheckState = 'passing' | 'failing' | 'pending' | 'missing';

interface Response {
  status: number;
  body: unknown;
}

interface CheckResult {
  pr: string;
  head_sha: string;
  check: string;
  state: CheckState;
}

interface Policy {
  requirement: 'none' | 'required' | 'unknown';
  source: 'declared' | 'github' | '';
  checks: string[];
  checks_state: CheckState | 'not_applicable' | 'unknown';
  results: CheckResult[];
  reason: string;
}

const passingConclusions = new Set(['success', 'neutral', 'skipped']);

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function gh(args: string[]): { exitCode: number; stdout: string } {
  const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout?.toString() ?? '' };
}

// `gh api --include` prints the status line and headers on stdout even when it
// exits non-zero for a 4xx, so the decision rests on the HTTP status, not on
// GitHub's error wording.
function api(path: string): Response {
  const { stdout } = gh(['api', '--include', path]);
  const status = /^HTTP\/[\d.]+ (\d{3})/.exec(stdout);
  if (status === null) return { status: 0, body: null };
  const separator = stdout.search(/\r?\n\r?\n/);
  const text = separator === -1 ? '' : stdout.slice(separator).trim();
  let body: unknown = null;
  try {
    body = text === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    body = null;
  }
  return { status: Number(status[1]), body };
}

// Paginated list reads; null means the read failed and nothing may be inferred.
function list(path: string, jq: string): JsonObject[] | null {
  const { exitCode, stdout } = gh(['api', '--paginate', path, '--jq', jq]);
  if (exitCode !== 0) return null;
  try {
    return stdout
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => object(JSON.parse(line) as unknown));
  } catch {
    return null;
  }
}

function declared(raw: string): string[] | undefined | 'invalid' {
  const value = raw.trim();
  if (value === '') return undefined;
  if (value.toLowerCase() === 'none') return [];
  const names = value.split(',').map(name => name.trim());
  if (
    names.some(
      name => name === '' || name.toLowerCase() === 'none' || /[\u0000-\u001f]/.test(name)
    )
  ) {
    return 'invalid';
  }
  return [...new Set(names)];
}

function emit(policy: Policy): void {
  console.log(JSON.stringify(policy));
}

function unknown(reason: string, checks: string[] = []): void {
  emit({ requirement: 'unknown', source: '', checks, checks_state: 'unknown', results: [], reason });
}

function protectedChecks(body: unknown): string[] | null {
  const protection = object(body).protection;
  if (protection === undefined) return null;
  const required = object(object(protection).required_status_checks);
  const contexts = array(required.contexts).filter((name): name is string => typeof name === 'string');
  const checks = array(required.checks)
    .map(check => object(check).context)
    .filter((name): name is string => typeof name === 'string');
  return [...contexts, ...checks];
}

function rulesetChecks(body: unknown): string[] {
  return array(body)
    .map(object)
    .filter(rule => rule.type === 'required_status_checks')
    .flatMap(rule => array(object(rule.parameters).required_status_checks))
    .map(check => object(check).context)
    .filter((name): name is string => typeof name === 'string');
}

function stateOf(name: string, runs: JsonObject[], statuses: JsonObject[]): CheckState {
  const run = runs
    .filter(item => item.name === name)
    .sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0))[0];
  if (run !== undefined) {
    if (run.status !== 'completed') return 'pending';
    return passingConclusions.has(String(run.conclusion)) ? 'passing' : 'failing';
  }
  // The statuses endpoint lists newest first.
  const status = statuses.find(item => item.context === name);
  if (status === undefined) return 'missing';
  if (status.state === 'success') return 'passing';
  if (status.state === 'pending') return 'pending';
  return 'failing';
}

// The pull request's own status rollup (GraphQL) lists its head's check runs and
// commit statuses in one read. GitHub's REST check endpoints can fail for a commit
// whose rollup still answers (seen live: HTTP 500 on a merged-ready head), so the
// rollup is read first and REST is the fallback.
function fromRollup(rollup: unknown[]): { runs: JsonObject[]; statuses: JsonObject[] } {
  const runs: JsonObject[] = [];
  const statuses: JsonObject[] = [];
  for (const [index, item] of rollup.map(object).entries()) {
    if (item.__typename === 'StatusContext') {
      statuses.push({ context: item.context, state: String(item.state ?? '').toLowerCase() });
    } else if (item.__typename === 'CheckRun') {
      const started = Date.parse(String(item.startedAt ?? ''));
      runs.push({
        id: Number.isNaN(started) ? index : started,
        name: item.name,
        status: String(item.status ?? '').toLowerCase(),
        conclusion: String(item.conclusion ?? '').toLowerCase(),
      });
    }
  }
  return { runs, statuses };
}

function aggregate(results: CheckResult[]): CheckState {
  for (const state of ['failing', 'pending', 'missing'] as const) {
    if (results.some(result => result.state === state)) return state;
  }
  return 'passing';
}

function main(): void {
  let prs: unknown;
  try {
    prs = JSON.parse(process.env.INPUTS_PRS ?? '') as unknown;
  } catch {
    prs = null;
  }
  const urls = array(prs).filter((url): url is string => typeof url === 'string');
  const identities = urls.map(url => /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(url));
  if (urls.length === 0 || identities.some(match => match === null)) {
    unknown('the requested pull requests are not a JSON array of pull request URLs');
    return;
  }
  const repositories = new Set(identities.map(match => match?.[1]));
  if (repositories.size !== 1) {
    unknown('the requested pull requests span more than one repository');
    return;
  }
  const repository = [...repositories][0] as string;

  const heads: { url: string; head: string; rollup: unknown[] | null }[] = [];
  const bases = new Set<string>();
  for (const [index, match] of identities.entries()) {
    const view = gh(['pr', 'view', match?.[2] ?? '', '--repo', repository, '--json', 'baseRefName,headRefOid,statusCheckRollup']);
    let pr: JsonObject = {};
    try {
      pr = object(JSON.parse(view.stdout) as unknown);
    } catch {
      // An unreadable pull request is reported below.
    }
    if (view.exitCode !== 0 || typeof pr.baseRefName !== 'string' || typeof pr.headRefOid !== 'string') {
      unknown(`could not read pull request ${urls[index]}`);
      return;
    }
    bases.add(pr.baseRefName);
    heads.push({
      url: urls[index] as string,
      head: pr.headRefOid,
      rollup: Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : null,
    });
  }
  if (bases.size !== 1) {
    unknown('the requested pull requests target more than one base branch');
    return;
  }
  const base = [...bases][0] as string;

  const declaration = declared(process.env.INPUTS_REQUIRED_CHECKS ?? '');
  if (declaration === 'invalid') {
    unknown('required_checks must be empty, "none", or a comma-separated list of check names');
    return;
  }

  const branch = api(`repos/${repository}/branches/${encodeURIComponent(base)}`);
  const rules = api(`repos/${repository}/rules/branches/${encodeURIComponent(base)}?per_page=100`);
  const classic = branch.status === 200 ? protectedChecks(branch.body) : null;
  const rulesets = rules.status === 200 ? rulesetChecks(rules.body) : null;
  const enforced = [...(classic ?? []), ...(rulesets ?? [])];

  let checks: string[];
  let source: Policy['source'];
  if (declaration !== undefined) {
    checks = [...new Set([...declaration, ...enforced])];
    source = 'declared';
  } else if (classic !== null && rulesets !== null) {
    checks = [...new Set(enforced)];
    source = 'github';
  } else {
    const unread = [
      classic === null ? `branch protection (HTTP ${branch.status || 'unreadable'})` : '',
      rulesets === null ? `rulesets (HTTP ${rules.status || 'unreadable'})` : '',
    ].filter(Boolean);
    unknown(
      `GitHub did not report the required checks for ${repository}@${base}: ${unread.join(', ')}. ` +
        'Declare them with the required_checks input: "none", or a comma-separated list of ' +
        'check names (for example "tests").'
    );
    return;
  }

  if (checks.length === 0) {
    emit({ requirement: 'none', source, checks, checks_state: 'not_applicable', results: [], reason: '' });
    return;
  }

  const results: CheckResult[] = [];
  for (const { url, head, rollup } of heads) {
    const read = rollup !== null ? fromRollup(rollup) : null;
    const runs =
      read?.runs ??
      list(
        `repos/${repository}/commits/${head}/check-runs?per_page=100`,
        '.check_runs[] | {id, name, status, conclusion}'
      );
    const statuses =
      read?.statuses ??
      list(`repos/${repository}/commits/${head}/statuses?per_page=100`, '.[] | {context, state}');
    if (runs === null || statuses === null) {
      emit({
        requirement: 'required',
        source,
        checks,
        checks_state: 'unknown',
        results,
        reason: `could not read check results for ${url} at ${head}`,
      });
      return;
    }
    for (const check of checks) {
      results.push({ pr: url, head_sha: head, check, state: stateOf(check, runs, statuses) });
    }
  }
  const state = aggregate(results);
  const unmet = results.filter(result => result.state !== 'passing');
  emit({
    requirement: 'required',
    source,
    checks,
    checks_state: state,
    results,
    reason: unmet.map(result => `${result.check} is ${result.state} on ${result.pr}`).join('; '),
  });
}

main();
