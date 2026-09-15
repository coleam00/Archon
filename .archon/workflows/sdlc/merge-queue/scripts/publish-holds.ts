type JsonObject = Record<string, unknown>;

const marker = '<!-- archon-merge-hold -->';

function required(name: string): string {
  const value = process.env[`INPUTS_${name}`];
  if (value === undefined) throw new Error(`publish-holds: INPUTS_${name} is required`);
  return value;
}

function parse(name: string): unknown {
  return JSON.parse(required(name)) as unknown;
}

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('publish-holds: hold entries must be objects');
  }
  return value as JsonObject;
}

function prIdentity(url: string): { repository: string; number: number } {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)$/.exec(url);
  if (match === null) throw new Error(`publish-holds: unsupported pull request URL ${url}`);
  return { repository: match[1], number: Number(match[2]) };
}

function runGh(args: string[]): unknown {
  const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`publish-holds: gh ${args[0]} failed with exit ${result.exitCode}`);
  }
  const output = result.stdout.toString().trim();
  return output === '' ? null : (JSON.parse(output) as unknown);
}

function comments(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) throw new Error('publish-holds: comment readback is malformed');
  const flattened = value.flatMap(page => (Array.isArray(page) ? page : [page]));
  return flattened.map(object);
}

const mode = required('MODE');
if (!['preview', 'approve', 'auto'].includes(mode)) {
  throw new Error('publish-holds: mode must be preview, approve, or auto');
}
const publish = required('PUBLISH_HOLDS');
if (!['true', 'false'].includes(publish)) {
  throw new Error('publish-holds: publish_holds must be true or false');
}

const requested = parse('PRS');
if (
  !Array.isArray(requested) ||
  requested.length < 1 ||
  requested.length > 5 ||
  !requested.every(url => typeof url === 'string') ||
  new Set(requested).size !== requested.length
) {
  throw new Error('publish-holds: prs must contain 1-5 distinct URLs');
}
const repositories = new Set(requested.map(url => prIdentity(url).repository));
if (repositories.size !== 1) throw new Error('publish-holds: prs must use one repository');
const requestedUrls = new Set(requested);
const rawHolds = parse('HOLDS');
if (!Array.isArray(rawHolds)) throw new Error('publish-holds: holds must be an array');

const holds = rawHolds.map(value => {
  const hold = object(value);
  if (
    typeof hold.pr_url !== 'string' ||
    !requestedUrls.has(hold.pr_url) ||
    typeof hold.head_sha !== 'string' ||
    hold.head_sha === '' ||
    !['hold', 'clear'].includes(String(hold.action)) ||
    !Array.isArray(hold.reasons) ||
    !hold.reasons.every(reason => typeof reason === 'string' && reason.trim() !== '')
  ) {
    throw new Error('publish-holds: malformed or unrequested hold entry');
  }
  if (hold.action === 'hold' && hold.reasons.length === 0) {
    throw new Error('publish-holds: a hold must include evidence-backed reasons');
  }
  if (hold.action !== 'hold' && hold.reasons.length !== 0) {
    throw new Error('publish-holds: only a hold may include reasons');
  }
  return hold as {
    pr_url: string;
    head_sha: string;
    action: 'hold' | 'clear';
    reasons: string[];
  };
});
if (new Set(holds.map(hold => hold.pr_url)).size !== holds.length) {
  throw new Error('publish-holds: holds must not contain duplicate PRs');
}

if (mode === 'preview' || publish === 'false') {
  console.log(JSON.stringify({ published: false, updated: [], summary: 'hold publication disabled' }));
  process.exit(0);
}

const updated: string[] = [];
for (const hold of holds) {
  const { repository, number } = prIdentity(hold.pr_url);
  const listed = runGh([
    'api',
    '--hostname',
    'github.com',
    `repos/${repository}/issues/${number}/comments?per_page=100`,
    '--paginate',
    '--slurp',
  ]);
  const existing = comments(listed).filter(comment =>
    typeof comment.body === 'string' && comment.body.startsWith(marker)
  );
  if (existing.length > 1) throw new Error('publish-holds: multiple hold comments are ambiguous');
  const body =
    hold.action === 'hold'
      ? `${marker}\nHeld at \`${hold.head_sha}\`:\n${hold.reasons.map(reason => `- ${reason}`).join('\n')}`
      : `${marker}\nHold cleared at \`${hold.head_sha}\`.`;
  if (existing.length === 1) {
    const id = existing[0].id;
    if (!Number.isInteger(id)) throw new Error('publish-holds: existing comment has no integer id');
    runGh(['api', '--hostname', 'github.com', `repos/${repository}/issues/comments/${id}`, '--method', 'PATCH', '-f', `body=${body}`]);
    updated.push(hold.pr_url);
  } else if (hold.action === 'hold') {
    runGh(['api', '--hostname', 'github.com', `repos/${repository}/issues/${number}/comments`, '--method', 'POST', '-f', `body=${body}`]);
    updated.push(hold.pr_url);
  }
}

console.log(JSON.stringify({ published: updated.length > 0, updated, summary: `updated ${updated.length} hold comment(s)` }));
