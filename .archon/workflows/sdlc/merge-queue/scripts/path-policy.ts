// Whether a pull request changes a protected path is a fact, so a script reads it
// and the gate enforces it. Review is not a guard: a reviewed delivery once
// rewrote a governance file and merged with nobody flagging it. Patterns are
// anchored at the repository root: `*` and `?` stay inside one path segment, `**`
// spans segments, and a trailing `/` covers everything under that directory.

type JsonObject = Record<string, unknown>;

interface Match {
  pr: string;
  head_sha: string;
  files: string[];
}

interface Policy {
  state: 'not_applicable' | 'clear' | 'protected' | 'unknown';
  patterns: string[];
  heads: { pr: string; head_sha: string }[];
  matches: Match[];
  reason: string;
}

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

function emit(policy: Policy): void {
  console.log(JSON.stringify(policy));
}

function unknown(reason: string, patterns: string[] = []): void {
  emit({ state: 'unknown', patterns, heads: [], matches: [], reason });
}

function declared(raw: string): string[] | 'invalid' {
  const value = raw.trim();
  if (value === '' || value.toLowerCase() === 'none') return [];
  const patterns = value.split(',').map(pattern => pattern.trim());
  if (patterns.some(pattern => pattern === '' || pattern === '/' || /\p{Cc}/u.test(pattern))) {
    return 'invalid';
  }
  return [...new Set(patterns)];
}

function patternRegex(pattern: string): RegExp {
  let glob = pattern.replace(/^\/+/, '');
  if (glob.endsWith('/')) glob += '**';
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      const slashAfter = glob[index + 2] === '/';
      source += slashAfter ? '(?:.*/)?' : '.*';
      index += slashAfter ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

function main(): void {
  const declaration = declared(process.env.INPUTS_PROTECTED_PATHS ?? '');
  if (declaration === 'invalid') {
    unknown('protected_paths must be empty, "none", or a comma-separated list of path patterns');
    return;
  }
  if (declaration.length === 0) {
    emit({ state: 'not_applicable', patterns: [], heads: [], matches: [], reason: '' });
    return;
  }
  const patterns = declaration;
  const regexes = patterns.map(patternRegex);

  let prs: unknown;
  try {
    prs = JSON.parse(process.env.INPUTS_PRS ?? '') as unknown;
  } catch {
    prs = null;
  }
  const urls = array(prs).filter((url): url is string => typeof url === 'string');
  const identities = urls.map(url => /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(url));
  if (urls.length === 0 || identities.some(match => match === null)) {
    unknown('the requested pull requests are not a JSON array of pull request URLs', patterns);
    return;
  }

  const heads: Policy['heads'] = [];
  const matches: Match[] = [];
  for (const [index, match] of identities.entries()) {
    const url = urls[index];
    const repository = match?.[1] ?? '';
    const number = match?.[2] ?? '';
    const view = gh(['pr', 'view', number, '--repo', repository, '--json', 'headRefOid,changedFiles']);
    let pr: JsonObject = {};
    try {
      pr = object(JSON.parse(view.stdout) as unknown);
    } catch {
      // Reported below.
    }
    if (view.exitCode !== 0 || typeof pr.headRefOid !== 'string' || pr.headRefOid === '') {
      unknown(`could not read pull request ${url}`, patterns);
      return;
    }
    const head = pr.headRefOid;
    const listed = gh([
      'api',
      '--paginate',
      `repos/${repository}/pulls/${number}/files?per_page=100`,
      '--jq',
      '.[] | {filename, previous_filename}',
    ]);
    if (listed.exitCode !== 0) {
      unknown(`could not list the changed files of ${url}`, patterns);
      return;
    }
    const files = new Set<string>();
    let entries = 0;
    try {
      for (const line of listed.stdout.split('\n')) {
        if (line.trim() === '') continue;
        const entry = object(JSON.parse(line) as unknown);
        entries += 1;
        for (const name of [entry.filename, entry.previous_filename]) {
          if (typeof name === 'string' && name !== '') files.add(name);
        }
      }
    } catch {
      unknown(`could not parse the changed files of ${url}`, patterns);
      return;
    }
    // GitHub lists at most 3000 files; a short listing proves nothing about the rest.
    if (typeof pr.changedFiles === 'number' && entries < pr.changedFiles) {
      unknown(
        `GitHub listed ${entries} of ${pr.changedFiles} changed files of ${url}; the rest cannot be checked`,
        patterns
      );
      return;
    }
    heads.push({ pr: url, head_sha: head });
    const hit = [...files].filter(file => regexes.some(regex => regex.test(file))).sort();
    if (hit.length > 0) matches.push({ pr: url, head_sha: head, files: hit });
  }

  emit({
    state: matches.length > 0 ? 'protected' : 'clear',
    patterns,
    heads,
    matches,
    reason: matches
      .map(
        item =>
          `${item.pr} changes protected ${item.files.length === 1 ? 'path' : 'paths'} ` +
          `${item.files.join(', ')}; a human must make this change`
      )
      .join('; '),
  });
}

main();

// A module, so its declarations stay private to this script.
export {};
