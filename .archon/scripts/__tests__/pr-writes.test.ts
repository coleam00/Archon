/**
 * The pack's pull-request writes, through both sources.
 *
 * Fixtures stub these nodes, so only a subprocess run can observe what they
 * actually write, which source they wrote through, and whether a write that did
 * not read back is reported as a failure rather than a delivery.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DESCRIPTION_SECTION } from '../../workflows/sdlc/.shared/pr';
import {
  ForgeOperationError,
  ghRetryWait,
  retryTransient,
  TransientForgeError,
} from '../../workflows/sdlc/.shared/forge';
import { trackTempRoots } from './temp-roots';
import {
  PACK,
  PR,
  PR_URL,
  forgeOperation,
  forgeFailure,
  forgePrRecord,
  gitCheckout,
  packScriptRunner,
  type ScriptOptions,
  type ScriptRun,
} from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();
const trackTempRoot = trackTempRoots();

const MARKER = '<!-- archon-review-report -->';
const REPORT = 'Round 1: ready';

/** The engine's typed-artifact listing for a run with no typed artifacts yet. */
const EMPTY_LISTING = JSON.stringify({ runId: 'run', artifactsByType: {}, errors: [] });
const DESCRIPTION = { type: 'archon_artifact', run_id: 'run', path: 'pr-description.md' };
const PREPARED_BODY = { type: 'archon_artifact', run_id: 'run', path: 'pr-body.md' };

interface Target {
  readonly headRepo?: { host: string; path: string };
  readonly head?: string;
  readonly existing?: number | null;
}

/**
 * Run publish-pr in a real checkout whose `upstream` remote is the recorded
 * repository (a local bare repository behind `url.insteadOf`), so the push it makes
 * first lands and reads back. The fake forge reports that pushed commit as the head.
 */
function publishPr(
  options: ScriptOptions & { target?: Target; prepareBody?: boolean; forgeAt?: (head: string) => ScriptOptions['forge'] } = {}
): ScriptRun & { head: string; cwd: string } {
  const { target = {}, prepareBody = true, forgeAt, ...rest } = options;
  const cwd = gitCheckout({}, trackTempRoot);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
  const run = runPackScript('pr/scripts/publish-pr', {
    source: 'gh',
    ...rest,
    ...(forgeAt ? { forge: forgeAt(head) } : {}),
    cwd,
    gh: { ...rest.gh, pr: { headRefOid: head, ...rest.gh?.pr } },
    inputs: {
      INPUTS_REPO: JSON.stringify(PR.repo),
      INPUTS_HEAD_REPO: JSON.stringify(target.headRepo ?? PR.repo),
      INPUTS_HEAD: target.head ?? 'feature',
      INPUTS_BASE: 'dev',
      // The engine binds a field prepare declared null as empty text.
      INPUTS_EXISTING: target.existing == null ? '' : JSON.stringify(target.existing),
      INPUTS_TITLE: 'A title',
      WORKFLOW_ID: 'run',
      INPUTS_BODY: prepareBody ? JSON.stringify(PREPARED_BODY) : '',
      INPUTS_DRAFT: 'true',
      TYPED_ARTIFACTS_FILE: '{ARTIFACTS}/listing.json',
      ...rest.inputs,
    },
    artifacts: { ...(prepareBody ? { [PREPARED_BODY.path]: 'A body' } : {}), 'listing.json': EMPTY_LISTING, ...rest.artifacts },
  });
  return { ...run, head, cwd };
}

describe('publish-pr opens the pull request at most once', () => {
  it.each(['gh', 'forge'] as const)('continues without a publication record when no description is prepared through %s', source => {
    for (const existing of [42, null]) {
      const result = publishPr({
        source,
        target: { existing },
        prepareBody: false,
        forgeAt: head => ({ kind: 'fake', response: forgeOperation('pr.view', { pr: forgePrRecord({ head_revision: head }) }) }),
        preload: `import { mkdirSync } from 'node:fs'; mkdirSync('{ARTIFACTS}/pr-create-started');`,
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ number: 42, head_revision: result.head });
      expect(remoteHead(result.cwd, 'feature')).toBe(result.head);
      expect(result.bodies).toEqual([]);
    }
  });

  it.each([{ field: 'body', pointer: PREPARED_BODY }, { field: 'description', pointer: DESCRIPTION }])('keeps the $field pointer schema and command aligned with publish', ({ field, pointer }) => {
    const workflow = Bun.YAML.parse(readFileSync(join(PACK, 'pr/archon-pr.yaml'), 'utf8')) as {
      nodes: { id: string; output_format?: { properties: Record<string, unknown> } }[];
    };
    expect(workflow.nodes.find(node => node.id === 'prepare')?.output_format?.properties[field]).toEqual({
      type: ['object', 'null'],
      properties: {
        type: { type: 'string', enum: [pointer.type] },
        run_id: { type: 'string' },
        path: { type: 'string', enum: [pointer.path] },
      },
      required: Object.keys(pointer),
    });
    const command = readFileSync(join(PACK, 'pr/commands/pr.md'), 'utf8');
    expect(command).toContain(
      `{"type": "${pointer.type}", "run_id": "$WORKFLOW_ID", "path": "${pointer.path}"}`
    );
    expect(command).toContain(`$ARTIFACTS_DIR/${pointer.path}`);
  });

  it.each(['gh', 'forge'] as const)(
    'refuses another create through %s while the earlier write is unresolved',
    source => {
      const result = publishPr({
        source,
        artifacts: { 'pr-create-started': JSON.stringify({ repo: PR.repo }) },
        gh: { noOpenPr: true },
        forge: { kind: 'fake', response: forgeOperation('pr.view', null) },
      });
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('a previous PR create is unresolved');
      expect(result.gh.some(call => call.startsWith('pr create'))).toBe(false);
      expect(result.forge.some(call => call.includes('forge pr.create'))).toBe(false);
    }
  );

  it.each(['gh', 'forge'] as const)(
    'reconciles a previously started create through %s when its PR is visible',
    source => {
      const result = publishPr({
        source,
        artifacts: { 'pr-create-started': JSON.stringify({ repo: PR.repo }) },
        gh: { pr: { headRefName: 'feature' } },
        forgeAt: head => ({
          kind: 'fake',
          response: forgeOperation('pr.view', { pr: forgePrRecord({ head_revision: head }) }),
        }),
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ number: 42 });
      expect(result.gh.some(call => call.startsWith('pr create'))).toBe(false);
      expect(result.forge.some(call => call.includes('forge pr.create'))).toBe(false);
    }
  );

  it('creates and verifies through gh when the head has no open pull request', () => {
    const result = publishPr({ gh: { noOpenPr: true, pr: { headRefName: 'feature' } } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42, url: PR_URL, is_draft: true });
    expect(result.gh.some(call => call.startsWith('pr create'))).toBe(true);
    expect(result.gh.every(call => call.includes('--repo ghe.example.com/example/repo'))).toBe(true);
    expect(result.forge).toEqual([]);
  });

  it.each(['gh', 'forge'] as const)('refuses to open a pull request through %s without a body, leaving no claim', source => {
    const result = publishPr({
      source,
      forge: { kind: 'fake', response: forgeOperation('pr.view', null) },
      gh: { noOpenPr: true, pr: { headRefName: 'feature' } },
      prepareBody: false,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('prepare wrote no body');
    expect(result.forge.some(call => call.includes('forge pr.create'))).toBe(false);
    expect(result.gh.some(call => call.startsWith('pr create'))).toBe(false);
    expect(existsSync(join(result.artifacts, 'pr-create-started'))).toBe(false);
  });

  it.each(['gh', 'forge'] as const)('requires the declared body before creating through %s', source => {
    for (const leftover of ['', 'An old body']) {
      const result = publishPr({
        source,
        target: { existing: 42 },
        inputs: { INPUTS_BRANCH: 'selected', INPUTS_BODY: 'null' },
        gh: { noOpenPr: true },
        forge: { kind: 'fake', response: forgeOperation('pr.view', null) },
        artifacts: { 'pr-body.md': leftover },
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('prepare wrote no body');
      expect(result.gh.some(call => call.startsWith('pr create'))).toBe(false);
      expect(result.forge.some(call => call.includes('forge pr.create'))).toBe(false);
      expect(existsSync(join(result.artifacts, 'pr-create-started'))).toBe(false);
    }
  });

  it.each(['gh', 'forge'] as const)('rejects a body pointer outside its declared contract through %s', source => {
    for (const override of [{ type: 'file' }, { run_id: 'other-run' }, { path: 'other-body.md' }, { path: '../pr-body.md' }]) {
      const result = publishPr({
        source,
        inputs: { INPUTS_BODY: JSON.stringify({ ...PREPARED_BODY, ...override }) },
        gh: { noOpenPr: true },
        forge: { kind: 'fake', response: forgeOperation('pr.view', null) },
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('prepare must declare the pr-body.md artifact from this run');
      expect(result.gh.some(call => call.startsWith('pr create'))).toBe(false);
      expect(result.forge.some(call => call.includes('forge pr.create'))).toBe(false);
      expect(existsSync(join(result.artifacts, 'pr-create-started'))).toBe(false);
    }
  });

  it.each(['gh', 'forge'] as const)('reads the body before claiming a create through %s', source => {
    for (const directory of [false, true]) {
      const result = publishPr({
        source,
        prepareBody: false,
        inputs: { INPUTS_BODY: JSON.stringify({ type: 'archon_artifact', run_id: 'run', path: 'pr-body.md' }) },
        artifacts: directory ? { 'pr-body.md/entry': 'a directory cannot be a PR body' } : {},
        gh: { noOpenPr: true },
        forge: { kind: 'fake', response: forgeOperation('pr.view', null) },
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(directory ? 'EISDIR' : 'ENOENT');
      expect(result.gh.some(call => call.startsWith('pr create'))).toBe(false);
      expect(result.forge.some(call => call.includes('forge pr.create'))).toBe(false);
      expect(existsSync(join(result.artifacts, 'pr-create-started'))).toBe(false);
    }
  });

  it('reuses the open pull request for that head instead of opening a second one', () => {
    const result = publishPr({ gh: { pr: { headRefName: 'feature' } } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42 });
    expect(result.gh.some(call => call.startsWith('pr create'))).toBe(false);
    expect(result.stderr).toContain('already has this head');
  });

  it('refuses when a create reports success but no pull request has that head', () => {
    const result = publishPr({ gh: { noOpenPr: true, writeLost: true } });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('a pull request may exist');
  });

  it('refuses when the created pull request does not match what was requested', () => {
    const result = publishPr({
      gh: { noOpenPr: true, pr: { headRefName: 'feature', headRefOid: 'a-different-revision' } },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('does not match what was requested');
  });

  it('publishes through the plugin, never gh, on the forge source', () => {
    const result = publishPr({
      source: 'forge',
      forge: {
        kind: 'fake',
        response: [
          forgeOperation('pr.view', null),
          forgeOperation('pr.create', {
            target: PR.repo,
            outcome: 'applied',
            changed: true,
            pr: forgePrRecord(),
          }),
        ],
      },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42, url: PR_URL });
    expect(result.gh).toEqual([]);
    expect(result.forge[1]).toContain('forge pr.create --json --data-file');
    // The authored body travels in the request file, never on the command line.
    expect(result.forge.join(' ')).not.toContain('A body');
    expect(JSON.parse(result.forgeRequests[1]).body).toBe('A body');
  });

  it('reports a refused create as a refusal that wrote nothing', () => {
    const result = publishPr({
      source: 'forge',
      forge: {
        kind: 'fake',
        response: [
          forgeOperation('pr.view', null),
          forgeFailure('pr.create', 'refused', 'the base branch does not exist'),
        ],
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('refused');
    expect(result.stderr).toContain('the base branch does not exist');
    // Nothing was written, so a retry may create.
    expect(existsSync(join(result.artifacts, 'pr-create-started'))).toBe(false);
  });

  it.each(['outcome_unknown', 'verification_failed'] as const)(
    'keeps the create claim after a %s create so a retry cannot open a duplicate',
    outcome => {
      const result = publishPr({
        source: 'forge',
        forge: {
          kind: 'fake',
          response: [
            forgeOperation('pr.view', null),
            forgeFailure('pr.create', outcome, 'forge plugin timed out'),
          ],
        },
      });
      expect(result.code).not.toBe(0);
      expect(existsSync(join(result.artifacts, 'pr-create-started'))).toBe(true);
    }
  );

  it('reuses the open pull request when the head repository differs only in case', () => {
    const result = publishPr({
      target: { headRepo: { host: PR.repo.host, path: 'Example/Repo' } },
      gh: { pr: { headRefName: 'feature' } },
    });
    expect(result.code).toBe(0);
    expect(result.gh.some(call => call.startsWith('pr create'))).toBe(false);
    expect(result.stderr).toContain('already has this head');
  });

  it('keeps the created pull request when the host could not audit the write', () => {
    const result = publishPr({
      source: 'forge',
      forge: {
        kind: 'fake',
        okExitCode: 2,
        response: [
          forgeOperation('pr.view', null),
          forgeOperation('pr.create', {
            target: PR.repo,
            outcome: 'applied',
            changed: true,
            pr: forgePrRecord(),
          }),
        ],
      },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42, url: PR_URL });
    expect(result.stderr).toContain("could not record it in the run's audit log");
  });

  it('reads back the pull request the run was launched onto instead of creating one', () => {
    const result = publishPr({
      target: { existing: 42 },
      prepareBody: false,
      gh: { pr: { headRefName: 'feature' } },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42 });
    expect(existsSync(join(result.artifacts, 'pr-body.md'))).toBe(false);
    expect(result.gh.some(call => call.startsWith('pr create'))).toBe(false);
    expect(result.gh.some(call => call.startsWith('pr list'))).toBe(false);
    expect(result.gh.some(call => call.startsWith('pr edit'))).toBe(false);
  });

  it('adopts a named pull request whose head repository differs only in case', () => {
    const result = publishPr({
      target: { headRepo: { host: PR.repo.host, path: 'Example/Repo' }, existing: 42 },
      gh: { pr: { headRefName: 'feature' } },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42 });
  });

  it('refuses before pushing when prepare did not continue the pull request the caller named', () => {
    for (const existing of [null, 41]) {
      const result = publishPr({ target: { existing }, inputs: { INPUTS_PULL_REQUEST: '42' } });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('the caller named pull request 42 to continue');
      expect(result.gh.some(call => call.startsWith('pr create'))).toBe(false);
    }
    const agreed = publishPr({
      target: { existing: 42 },
      inputs: { INPUTS_PULL_REQUEST: '42' },
      gh: { pr: { headRefName: 'feature' } },
    });
    expect(agreed.code).toBe(0);
    // A caller with no pull request to continue binds null.
    expect(publishPr({ inputs: { INPUTS_PULL_REQUEST: 'null' } }).code).toBe(0);
  });

  it('pushes a continued pull request to its own head, not the branch prepare recorded', () => {
    const result = publishPr({
      target: { existing: 42, head: 'archon/task-local' },
      gh: { pr: { headRefName: 'feature' } },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42 });
    expect(result.gh.some(call => call.startsWith('pr create'))).toBe(false);
    expect(remoteHead(result.cwd, 'feature')).toBe(result.head);
    expect(remoteHead(result.cwd, 'archon/task-local')).toBe('');
  });

  // GitHub's pull request API can report the previous head after the branch moved.
  // The first `gh pr view` is the read before the push; the next `stale` reads lag.
  const lagging = (stale: number) => `
const fakeSpawn = Bun.spawnSync.bind(Bun);
let views = 0;
Bun.sleepSync = () => {};
Object.defineProperty(Bun, 'spawnSync', { value: (argv, settings) => {
  const result = fakeSpawn(argv, settings);
  if (argv[0] !== 'gh' || argv[1] !== 'pr' || argv[2] !== 'view' || !argv.includes('--json')) return result;
  views++;
  if (views < 2 || views > 1 + ${String(stale)}) return result;
  const pr = JSON.parse(String(result.stdout));
  return { ...result, stdout: Buffer.from(JSON.stringify({ ...pr, headRefOid: 'stale' })) };
} });
`;

  it('waits for a continued pull request to report the pushed head before recording it', () => {
    const result = publishPr({
      target: { existing: 42 },
      gh: { pr: { headRefName: 'feature' } },
      preload: lagging(3),
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42, head_revision: result.head });
  });

  it('refuses when a continued pull request never reports the pushed head', () => {
    const result = publishPr({
      target: { existing: 42 },
      gh: { pr: { headRefName: 'feature' } },
      preload: lagging(100),
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`pushed ${result.head}, but pull request 42 still reports head stale`);
  });

  it.each(['CLOSED', 'MERGED'] as const)('refuses to push to a continued pull request that is %s', state => {
    const result = publishPr({ target: { existing: 42 }, gh: { pr: { state } } });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`pull request 42 is ${state.toLowerCase()}; nothing is pushed`);
    expect(remoteHead(result.cwd, 'feature')).toBe('');
  });

  it('opens the pull request from the branch the caller named', () => {
    const result = publishPr({
      inputs: { INPUTS_BRANCH: 'build/7-an-issue-run12345' },
      gh: { noOpenPr: true, pr: { headRefName: 'build/7-an-issue-run12345' } },
    });
    expect(result.code).toBe(0);
    expect(result.gh.some(call => call.startsWith('pr create') && call.includes('--head build/7-an-issue-run12345'))).toBe(true);
    expect(remoteHead(result.cwd, 'build/7-an-issue-run12345')).toBe(result.head);
    expect(remoteHead(result.cwd, 'feature')).toBe('');
  });

  it('a caller-named branch that already has an open pull request updates it, never opening another', () => {
    const result = publishPr({
      target: { head: 'archon/task-local' },
      prepareBody: false,
      inputs: { INPUTS_BRANCH: 'feature' },
      gh: { pr: { headRefName: 'feature' } },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42 });
    expect(result.gh.some(call => call.startsWith('pr create'))).toBe(false);
    expect(result.stderr).toContain('already has this head');
    expect(remoteHead(result.cwd, 'feature')).toBe(result.head);
  });

  it('opens its own pull request from the caller-named branch when prepare found one on another head', () => {
    const result = publishPr({
      target: { existing: 42 },
      inputs: { INPUTS_BRANCH: 'build/7-an-issue-run12345' },
      gh: { noOpenPr: true, pr: { headRefName: 'feature' } },
    });
    expect(result.code).toBe(0);
    expect(result.gh.some(call => call.startsWith('pr create') && call.includes('--head build/7-an-issue-run12345'))).toBe(true);
    expect(remoteHead(result.cwd, 'build/7-an-issue-run12345')).toBe(result.head);
    expect(remoteHead(result.cwd, 'feature')).toBe('');
  });

  it('refuses a caller-selected branch without a body when an unnamed PR has another head', () => {
    const result = publishPr({
      target: { existing: 42 },
      prepareBody: false,
      inputs: { INPUTS_BRANCH: 'build/7-an-issue-run12345' },
      gh: { noOpenPr: true, pr: { headRefName: 'feature' } },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('prepare wrote no body');
    expect(result.forge.some(call => call.includes('forge pr.create'))).toBe(false);
    expect(result.gh.some(call => call.startsWith('pr create'))).toBe(false);
    expect(existsSync(join(result.artifacts, 'pr-create-started'))).toBe(false);
  });

  it('continues a named pull request on its own head even when the caller also selected a branch', () => {
    const result = publishPr({
      target: { existing: 42 },
      prepareBody: false,
      inputs: { INPUTS_PULL_REQUEST: '42', INPUTS_BRANCH: 'build/7-an-issue-run12345' },
      gh: { pr: { headRefName: 'feature' } },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42 });
    expect(result.gh.some(call => call.startsWith('pr create'))).toBe(false);
    expect(remoteHead(result.cwd, 'feature')).toBe(result.head);
    expect(remoteHead(result.cwd, 'build/7-an-issue-run12345')).toBe('');
  });

  it('fails loudly when forge is selected but unavailable, never falling back to gh', () => {
    const result = publishPr({ source: 'forge', forge: { kind: 'no-host' } });
    expect(result.code).not.toBe(0);
    expect(result.gh).toEqual([]);
    expect(result.stderr).toContain('ARCHON_CLI_COMMAND is not set');
  });
});

const { start: START, end: END } = DESCRIPTION_SECTION;

/** publish-pr continuing pull request 42, with a prepared description section. */
function publishSection(options: Parameters<typeof publishPr>[0] & { live?: string; allowed?: boolean } = {}) {
  const { live = 'Written by hand.', allowed = true, ...rest } = options;
  return publishPr({
    target: { existing: 42 },
    prepareBody: false,
    ...rest,
    gh: { ...rest.gh, pr: { headRefName: 'feature', body: live, ...rest.gh?.pr } },
    inputs: {
      INPUTS_DESCRIPTION: JSON.stringify(DESCRIPTION),
      ...(allowed ? { INPUTS_PUBLISH_DESCRIPTION: 'true' } : {}),
      ...rest.inputs,
    },
    artifacts: { [DESCRIPTION.path]: '| case | ms |\n| --- | --- |\n| a | 12 |\n', ...rest.artifacts },
  });
}

describe('publish-pr writes the description section a delivery round prepared', () => {
  it('appends the section to a hand-written description and reads it back', () => {
    const result = publishSection();
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42, head_revision: result.head });
    expect(result.bodies).toEqual([`Written by hand.\n\n${START}\n| case | ms |\n| --- | --- |\n| a | 12 |\n\n${END}\n`]);
  });

  it.each([
    { trailing: '', gap: '\n\n' },
    { trailing: '\n', gap: '\n' },
    { trailing: '\n\n', gap: '' },
  ])('publishes terminal tables and replaces legacy table sections: $trailing', ({ trailing, gap }) => {
    const table = `| case | ms |\n| --- | --- |\n| a | 12 |${trailing}`;
    const first = publishSection({ artifacts: { [DESCRIPTION.path]: table } });
    expect({ code: first.code, stderr: first.stderr }).toMatchObject({ code: 0 });
    expect(first.bodies[0]).toBe(`Written by hand.\n\n${START}\n${table}${gap}${END}\n`);
    const again = publishSection({ live: first.bodies[0], artifacts: { [DESCRIPTION.path]: table } });
    expect({ code: again.code, stderr: again.stderr }).toMatchObject({ code: 0 });
    expect(again.bodies).toEqual([]);
    const legacy = `Author.  \n\n${START}\n${table}${trailing ? '' : '\n'}${END}\nAfter.  \n`;
    const replaced = publishSection({ live: legacy, artifacts: { [DESCRIPTION.path]: 'Replacement evidence.' } });
    expect({ code: replaced.code, stderr: replaced.stderr }).toMatchObject({ code: 0 });
    expect(replaced.bodies).toEqual([`Author.  \n\n${START}\nReplacement evidence.\n\n${END}\nAfter.  \n`]);
  });

  it.each(['gh', 'forge'] as const)('preserves fenced and inline marker examples through %s', source => {
    const live = `Author text.  \n\n\`\`\`md\n${START}\nexample\n${END}\n\`\`\`\nInline: \`${START}\` and \`${END}\`.  \n\n`;
    const result = publishSection({
      live, source,
      forgeAt: head => ({ kind: 'fake', response: [
        forgeOperation('pr.view', { pr: forgePrRecord({ head_revision: head }), title: 'A title', body: live }),
        forgeOperation('pr.view', { pr: forgePrRecord({ head_revision: head }), title: 'A title', body: live }),
        forgeOperation('pr.view', { pr: forgePrRecord({ head_revision: head }), title: 'A title', body: live }),
        forgeOperation('pr.edit-body', { pr: forgePrRecord({ head_revision: head }) }),
      ] }),
    });
    expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
    const body = source === 'gh' ? result.bodies[0] : JSON.parse(result.forgeRequests.at(-1) ?? '{}').body;
    expect(body).toBe(`${live}${START}\n| case | ms |\n| --- | --- |\n| a | 12 |\n\n${END}\n`);
  });

  it('preserves trailing authored whitespace exactly', () => {
    const live = 'Author text.  \n\n';
    const result = publishSection({ live });
    expect(result.code).toBe(0);
    expect(result.bodies[0]).toBe(`${live}${START}\n| case | ms |\n| --- | --- |\n| a | 12 |\n\n${END}\n`);
  });

  it('can publish prepared fenced marker examples again', () => {
    const section = `\`\`\`md\n${START}\nliteral\n${END}\n\`\`\``;
    const result = publishSection({ artifacts: { [DESCRIPTION.path]: section } });
    expect(result.code).toBe(0);
    const again = publishSection({ live: result.bodies[0], artifacts: { [DESCRIPTION.path]: section } });
    expect({ code: again.code, stderr: again.stderr }).toMatchObject({ code: 0 });
    expect(again.bodies).toEqual([]);
  });

  it.each([
    `    ${START}\n    literal\n    ${END}\n`,
    ...['pre', 'code', 'script', 'style', 'textarea', 'table', 'thead', 'tbody', 'tr', 'th', 'td'].map(tag => `<${tag}>\n\n${START}\nliteral\n${END}\n\n</${tag}>`),
  ])('preserves literal marker containers in both ingresses and can publish again: %s', section => {
    const live = `Authored.\n\n${section}\n\n`;
    const first = publishSection({ live, artifacts: { [DESCRIPTION.path]: section } });
    expect({ code: first.code, stderr: first.stderr }).toMatchObject({ code: 0 });
    expect(first.bodies[0]).toBe(`${live}${START}\n${section}${section.endsWith('\n\n') ? '' : section.endsWith('\n') ? '\n' : '\n\n'}${END}\n`);
    const again = publishSection({ live: first.bodies[0], artifacts: { [DESCRIPTION.path]: section } });
    expect({ code: again.code, stderr: again.stderr }).toMatchObject({ code: 0 });
    expect(again.bodies).toEqual([]);
  });

  it.each(['```', '~~~', '<pre>', '<code>', '<script>', '<style>', '<textarea>', '<table>'])(
    'refuses a composed pair swallowed by an unclosed %s in either ingress', opening => {
      for (const options of [
        { artifacts: { [DESCRIPTION.path]: `${opening}\nunfinished` } },
        { live: `Author text.\n\n${opening}\nunfinished` },
      ]) {
        const result = publishSection(options);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('composed description');
        expect(result.bodies).toEqual([]);
      }
    }
  );

  it.each([START, END, `${START}\nnested\n${END}`])('refuses reserved structural markers in prepared content before pushing: %s', section => {
    const result = publishSection({ artifacts: { [DESCRIPTION.path]: section } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('reserved description markers');
    expect(spawnSync('git', ['ls-remote', 'upstream', 'refs/heads/feature'], { cwd: result.cwd, encoding: 'utf8' }).stdout).toBe('');
    expect(result.gh).toEqual([]);
  });

  it('refuses reserved prepared markers before creating a pull request', () => {
    const result = publishSection({
      target: { existing: null }, prepareBody: true, gh: { noOpenPr: true },
      artifacts: { [DESCRIPTION.path]: `${START}\nnested\n${END}` },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('reserved description markers');
    expect(remoteHead(result.cwd, 'feature')).toBe('');
    expect(result.gh).toEqual([]);
  });

  it('publishes and reads back the section when creating a pull request', () => {
    const result = publishSection({ target: { existing: null }, prepareBody: true, gh: { noOpenPr: true } });
    expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
    expect(result.gh.some(call => call.startsWith('pr create'))).toBe(true);
    expect(result.bodies).toEqual([`A body\n\n${START}\n| case | ms |\n| --- | --- |\n| a | 12 |\n\n${END}\n`]);
    expect(result.gh.at(-1)).toContain('pr view 42');
  });

  it.each(['gh', 'forge'] as const)('keeps a created PR in the failure report when its description edit fails through %s', source => {
    const result = publishSection({ source, target: { existing: null }, prepareBody: true, gh: { noOpenPr: true },
      forgeAt: head => ({ kind: 'fake', response: [
        forgeOperation('pr.view', null),
        forgeOperation('pr.create', { target: PR.repo, outcome: 'applied', changed: true, pr: forgePrRecord({ head_revision: head }) }),
        forgeOperation('pr.view', { pr: forgePrRecord({ head_revision: head }), title: 'A title', body: 'A body' }),
        forgeFailure('pr.edit-body', 'refused', 'edit unavailable'),
      ] }),
      preload: `const spawn = Bun.spawnSync.bind(Bun); Object.defineProperty(Bun, 'spawnSync', { value: (argv, settings) => argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'edit' ? { exitCode: 1, stdout: Buffer.from(''), stderr: Buffer.from('edit unavailable') } : spawn(argv, settings) });`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('edit unavailable');
    const report = runPackScript('deliver/scripts/report', {
      inputs: { INPUTS_OUTCOME: 'null' },
      artifacts: { 'pr-create-started': readFileSync(join(result.artifacts, 'pr-create-started'), 'utf8') },
    });
    expect(JSON.parse(report.stdout)).toMatchObject({ ready: false, reason: 'failed', pr_url: PR_URL });
  });

  it.each(['gh', 'forge'] as const)('retains named and reconciled PR identities after a failed description edit through %s', source => {
    for (const { existing, priorClaim } of [42, null].flatMap(existing => [false, true].map(priorClaim => ({ existing, priorClaim })))) {
      const result = publishSection({ source, target: { existing },
        artifacts: priorClaim ? { 'pr-create-started': JSON.stringify({ repo: PR.repo, headRepo: PR.repo, head: 'feature' }) } : {},
        forgeAt: head => ({ kind: 'fake', response: [
          ...(existing === null ? [] : [forgeOperation('pr.view', { pr: forgePrRecord({ head_revision: head }) })]),
          forgeOperation('pr.view', { pr: forgePrRecord({ head_revision: head }), title: 'A title', body: 'A body' }),
          forgeOperation('pr.view', { pr: forgePrRecord({ head_revision: head }), title: 'A title', body: 'A body' }),
          forgeFailure('pr.edit-body', 'refused', 'edit unavailable'),
        ] }),
        preload: `const spawn = Bun.spawnSync.bind(Bun); Object.defineProperty(Bun, 'spawnSync', { value: (argv, settings) => argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'edit' ? { exitCode: 1, stdout: Buffer.from(''), stderr: Buffer.from('edit unavailable') } : spawn(argv, settings) });`,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('edit unavailable');
      const report = runPackScript('deliver/scripts/report', {
        inputs: { INPUTS_OUTCOME: 'null' },
        artifacts: { 'pr-create-started': readFileSync(join(result.artifacts, 'pr-create-started'), 'utf8') },
      });
      expect(report.code).toBe(0);
      expect(JSON.parse(report.stdout)).toMatchObject({ ready: false, reason: 'failed', pr_url: PR_URL });
    }
  });

  it.each([
    { name: 'replacement', live: `${START}\nold\n${END}` },
    { name: 'reusing a head PR', target: { existing: null }, prepareBody: true },
    { name: 'creating a PR', target: { existing: null }, prepareBody: true, gh: { noOpenPr: true } },
  ])('refuses invalid composition when $name', ({ name: _name, ...options }) => {
    const result = publishSection({ ...options, artifacts: { [DESCRIPTION.path]: '```\nunclosed' } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('composed description');
    expect(result.bodies).toEqual([]);
  });

  it('replaces only the content between its markers', () => {
    const result = publishSection({ live: `Before.\n\n${START}\nold\n${END}\n\nAfter.` });
    expect(result.code).toBe(0);
    expect(result.bodies).toEqual([`Before.\n\n${START}\n| case | ms |\n| --- | --- |\n| a | 12 |\n\n${END}\n\nAfter.`]);
  });

  it('writes nothing when the section is already current', () => {
    const result = publishSection({ live: `Before.\n\n${START}\n| case | ms |\n| --- | --- |\n| a | 12 |\n\n${END}\n` });
    expect(result.code).toBe(0);
    expect(result.gh.some(call => call.startsWith('pr edit'))).toBe(false);
  });

  it('writes through the plugin, never gh, on the forge source', () => {
    const result = publishSection({
      source: 'forge',
      forgeAt: head => {
        const view = forgeOperation('pr.view', {
          pr: forgePrRecord({ head_revision: head }),
          title: 'A title',
          body: 'Written by hand.',
        });
        return {
          kind: 'fake',
          response: [
            view,
            view,
            view,
            forgeOperation('pr.edit-body', {
              target: PR,
              outcome: 'applied',
              changed: true,
              pr: forgePrRecord({ head_revision: head }),
              bodyDigest: 'digest',
            }),
          ],
        };
      },
    });
    expect(result.code).toBe(0);
    expect(result.gh).toEqual([]);
    expect(result.forge[3]).toContain('forge pr.edit-body --json --data-file');
    expect(JSON.parse(result.forgeRequests[3])).toEqual({
      ref: { repo: PR.repo, number: 42 },
      body: `Written by hand.\n\n${START}\n| case | ms |\n| --- | --- |\n| a | 12 |\n\n${END}\n`,
    });
  });

  it.each([
    { ...DESCRIPTION, type: 'file' },
    { ...DESCRIPTION, run_id: 'another-run' },
    { ...DESCRIPTION, path: 'pr-body.md' },
  ])('refuses an uncertified description pointer before pushing: %j', pointer => {
    const result = publishSection({ inputs: { INPUTS_DESCRIPTION: JSON.stringify(pointer) } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('prepare must declare the pr-description.md artifact from this run');
    expect(remoteHead(result.cwd, 'feature')).toBe('');
    expect(result.gh).toEqual([]);
  });

  it('refuses a prepared section before pushing when the caller did not allow one', () => {
    const result = publishSection({ allowed: false });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('the caller did not allow publishing one');
    expect(remoteHead(result.cwd, 'feature')).toBe('');
    expect(result.bodies).toEqual([]);
  });

  it('refuses rather than guessing at an unpaired marker', () => {
    const result = publishSection({ live: `Before.\n\n${START}\nold` });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('unpaired or repeated archon-delivery-description marker');
    expect(result.bodies).toEqual([]);
  });

  it('fails when the written description does not read back', () => {
    const result = publishSection({ gh: { writeLost: true } });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('does not read back the written description');
  });

  it('names the same markers in the update-pr-body prompt that keeps them', () => {
    const prompt = readFileSync(join(PACK, 'deliver/commands/update-pr-body.md'), 'utf8');
    expect(prompt).toContain(`\`${START}\``);
    expect(prompt).toContain(`\`${END}\``);
  });
});

/** The commit the `upstream` remote holds for a branch, or empty when it has none. */
function remoteHead(cwd: string, branch: string): string {
  const remote = spawnSync('git', ['ls-remote', 'upstream', `refs/heads/${branch}`], { cwd, encoding: 'utf8' });
  return remote.stdout.trim().split(/\s/)[0] ?? '';
}

function publishReview(options: ScriptOptions = {}): ScriptRun {
  return runPackScript('review/scripts/publish-review', {
    source: 'gh',
    ...options,
    inputs: {
      INPUTS_PR: JSON.stringify(PR),
      INPUTS_REPORT: '{ARTIFACTS}/review/report.md',
      INPUTS_HEAD: REVIEWED,
      ARCHON_NODE_EXECUTION: atCommit(REVIEWED),
      INPUTS_READY: 'true',
      INPUTS_ACTION: 'none',
      INPUTS_SUMMARY: 'stub: nothing open',
      INPUTS_REPORT_POINTER: JSON.stringify({
        type: 'archon_artifact',
        run_id: 'fixture-run',
        path: 'review/report.md',
      }),
      INPUTS_DISCOVERIES: '[]',
      INPUTS_CONTRACT_LEFT: '["acceptance: the console shows it"]',
      ...options.inputs,
    },
    artifacts: { 'review-report.md': REPORT, ...options.artifacts },
  });
}

/** The PR head the fake gh and forge report, and so the commit a passing round reviewed. */
const REVIEWED = 'deadbeef';

function atCommit(commit: string): string {
  return JSON.stringify({ attempt: { checkoutStart: { kind: 'git', commit } } });
}

const prView = forgeOperation('pr.view', { pr: forgePrRecord(), title: 'A title', body: 'A body' });

describe('publish-review keeps one canonical comment per pull request', () => {
  const report = { INPUTS_REPORT: '{ARTIFACTS}/review-report.md' };

  it('creates the marked comment on the first round and edits it on the next', () => {
    const first = publishReview({ inputs: report });
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      ready: true,
      action: 'none',
      contract_left: ['acceptance: the console shows it'],
    });
    expect(first.gh.some(call => call.includes('--method POST'))).toBe(true);

    const second = publishReview({
      inputs: report,
      gh: { comments: [{ id: 5, body: `${MARKER}\nRound 1: ready\n` }] },
    });
    expect(second.code).toBe(0);
    expect(second.gh.some(call => call.includes('--method PATCH'))).toBe(true);
    expect(second.gh.some(call => call.includes('--method POST'))).toBe(false);
  });

  it('refuses rather than choosing between two marked comments', () => {
    const result = publishReview({
      inputs: report,
      gh: {
        comments: [
          { id: 1, body: `${MARKER}\nolder` },
          { id: 2, body: `${MARKER}\nnewer` },
        ],
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('more than one comment');
    expect(result.gh.some(call => call.includes('--method'))).toBe(false);
  });

  it('refuses when the written comment does not read back', () => {
    const result = publishReview({ inputs: report, gh: { writeLost: true } });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('does not read back as written');
  });

  it('publishes nothing for a working-diff review and still reports the verdict', () => {
    const result = publishReview({ inputs: { ...report, INPUTS_PR: 'null' } });
    expect(result.code).toBe(0);
    expect(result.gh).toEqual([]);
    expect(result.forge).toEqual([]);
    expect(JSON.parse(result.stdout)).toMatchObject({ ready: true, action: 'none' });
  });

  it('still accepts a legacy empty-object working-diff declaration', () => {
    const result = publishReview({ inputs: { ...report, INPUTS_PR: '{}' } });
    expect(result.code).toBe(0);
    expect(result.gh).toEqual([]);
    expect(result.forge).toEqual([]);
  });

  // Delivery hands the review its verified record as the scope. The scope agent's
  // declaration is then a restatement, not the authority: a wrong or empty one must
  // not move the comment or silently skip it.
  it.each([
    ['declares no pull request', 'null'],
    ['names another pull request', JSON.stringify({ ...PR, number: 43 })],
  ])('refuses when delivery recorded the target and the scope %s', (_label, declared) => {
    const result = publishReview({
      inputs: { ...report, INPUTS_SCOPE: JSON.stringify(PR), INPUTS_PR: declared },
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('delivery recorded');
    expect(result.gh.some(call => call.includes('--method'))).toBe(false);
  });

  it('publishes to the recorded pull request when the scope declaration agrees', () => {
    const result = publishReview({ inputs: { ...report, INPUTS_SCOPE: JSON.stringify(PR) } });
    expect(result.code).toBe(0);
    expect(result.gh.some(call => call.includes('repos/example/repo/issues/42/comments'))).toBe(
      true
    );
  });

  it('upserts through the plugin on the forge source, with the report in the request file', () => {
    const result = publishReview({
      source: 'forge',
      inputs: report,
      forge: {
        kind: 'fake',
        response: [
          prView,
          forgeOperation('comment.upsert', {
            target: PR,
            outcome: 'applied',
            changed: true,
            comment: {
              ref: PR,
              id: '900',
              url: `${PR_URL}#issuecomment-900`,
              bodyDigest: 'digest',
            },
          }),
        ],
      },
    });
    expect(result.code).toBe(0);
    expect(result.gh).toEqual([]);
    const request = JSON.parse(result.forgeRequests[1]) as { marker: string; body: string };
    expect(request.marker).toBe(MARKER);
    expect(request.body.split('\n')[0]).toBe(MARKER);
    expect(request.body).toContain(REPORT);
    // The comment names the commit it reviewed from the round's own record, not the report text.
    expect(request.body.split('\n')[1]).toBe(`Reviewed commit: \`${REVIEWED}\``);
    expect(request.body.split('\n')[2]).toBe('Verdict: ready');
    expect(result.forge.join(' ')).not.toContain(REPORT);
  });

  it('still reports the verdict when the host could not audit the comment write', () => {
    const result = publishReview({
      source: 'forge',
      inputs: report,
      forge: {
        kind: 'fake',
        okExitCode: 2,
        response: [
          prView,
          forgeOperation('comment.upsert', {
            target: PR,
            outcome: 'applied',
            changed: true,
            comment: {
              ref: PR,
              id: '900',
              url: `${PR_URL}#issuecomment-900`,
              bodyDigest: 'digest',
            },
          }),
        ],
      },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ready: true, action: 'none' });
    expect(result.stderr).toContain("could not record it in the run's audit log");
  });

  it('reports an unknown comment outcome without claiming the review was published', () => {
    const result = publishReview({
      source: 'forge',
      inputs: report,
      forge: {
        kind: 'fake',
        response: [prView, forgeFailure('comment.upsert', 'outcome_unknown', 'forge plugin timed out')],
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('outcome_unknown');
  });
});

// A forge that fails a request it may answer the next time (a gateway timeout, a
// rate limit) must not end a run that has done hours of work. The repeat is safe
// only because the comment write starts from the marker read, so a first attempt
// that landed is found rather than written twice.
describe('publish-review repeats a comment write the forge failed transiently', () => {
  const report = { INPUTS_REPORT: '{ARTIFACTS}/review-report.md' };
  const posts = (result: ScriptRun): number => result.gh.filter(call => call.includes('--method POST')).length;

  it('publishes exactly one comment after a 504 on the first write', () => {
    const result = publishReview({ inputs: report, gh: { commentWriteFaults: [{ status: 504 }] } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ready: true });
    expect(posts(result)).toBe(2);
    expect(result.comments).toHaveLength(1);
  });

  it('finds a 504 write that landed instead of writing it again', () => {
    const result = publishReview({ inputs: report, gh: { commentWriteFaults: [{ status: 504, landed: true }] } });
    expect(result.code).toBe(0);
    expect(posts(result)).toBe(1);
    expect(result.comments).toHaveLength(1);
  });

  it('fails at once with the forge evidence on a permanent error', () => {
    const result = publishReview({ inputs: report, gh: { commentWriteFaults: [{ status: 404 }] } });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('(HTTP 404)');
    expect(posts(result)).toBe(1);
    expect(result.comments).toEqual([]);
  });
});

describe('a gh api failure is classified from its HTTP status and headers', () => {
  const at = (status: number, headers: Record<string, string> = {}) =>
    ghRetryWait(1, { status, headers: new Map(Object.entries(headers)) });

  it('repeats a 5xx or a request that got no response, but not missing authentication', () => {
    expect(at(502)).toBe(0);
    expect(at(504)).toBe(0);
    expect(ghRetryWait(1, undefined)).toBe(0);
    expect(ghRetryWait(4, undefined)).toBeUndefined();
  });

  it('waits out a rate limit for the time GitHub names, or a minute', () => {
    expect(at(429, { 'retry-after': '30' })).toBe(30_000);
    expect(at(403, { 'retry-after': '5' })).toBe(5_000);
    expect(at(429)).toBe(60_000);
  });

  it('fails a permission refusal or any other 4xx at once', () => {
    expect(at(403)).toBeUndefined();
    expect(at(404)).toBeUndefined();
    expect(at(422)).toBeUndefined();
  });

  it('stops repeating after its last wait and never repeats another failure', () => {
    const waits: number[] = [];
    let attempts = 0;
    const transient = () => {
      attempts++;
      throw new TransientForgeError('gh api failed (HTTP 504)', 0);
    };
    expect(() => retryTransient(transient, ms => waits.push(ms))).toThrow('HTTP 504');
    expect(attempts).toBe(4);
    expect(waits).toEqual([1_000, 2_000, 4_000]);

    attempts = 0;
    const permanent = () => {
      attempts++;
      throw new ForgeOperationError('forge comment.upsert refused', undefined);
    };
    expect(() => retryTransient(permanent, () => {})).toThrow('refused');
    expect(attempts).toBe(1);
  });
});

// A round's verdict goes public only about the commit it reviewed. The stale case
// is a pull-request record whose head revision was captured when the PR opened:
// a report about that commit must not stand as the verdict on the PR's head.
describe('publish-review publishes a verdict only about the head it reviewed', () => {
  const report = { INPUTS_REPORT: '{ARTIFACTS}/review-report.md' };
  const STALE = 'stale0000';

  it('records the reviewed commit beside the report as the next round\'s cursor', () => {
    const result = publishReview({ inputs: report });
    expect(result.code).toBe(0);
    expect(readFileSync(join(result.artifacts, 'reviewed-head'), 'utf8').trim()).toBe(REVIEWED);
  });

  it('refuses a round that reviewed a commit the pull request no longer carries', () => {
    const result = publishReview({
      inputs: {
        ...report,
        INPUTS_SCOPE: JSON.stringify(PR),
        INPUTS_HEAD: STALE,
        ARCHON_NODE_EXECUTION: atCommit(STALE),
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`this round reviewed ${STALE}, but`);
    expect(result.stderr).toContain(`is at ${REVIEWED}`);
    expect(result.gh.some(call => call.includes('--method'))).toBe(false);
    expect(existsSync(join(result.artifacts, 'reviewed-head'))).toBe(false);
  });

  // An unpushed correction once reached publication with a scope that declared no
  // pull request; the error named the declaration instead of the unpushed head.
  it('names an unpushed head before any scope disagreement', () => {
    const result = publishReview({
      inputs: {
        ...report,
        INPUTS_SCOPE: JSON.stringify(PR),
        INPUTS_PR: 'null',
        INPUTS_HEAD: STALE,
        ARCHON_NODE_EXECUTION: atCommit(STALE),
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('the commits under review were not pushed');
    expect(result.stderr).not.toContain('delivery recorded');
  });

  it('refuses when the checkout moved after the round fixed its commit', () => {
    const result = publishReview({
      inputs: { ...report, ARCHON_NODE_EXECUTION: atCommit('moved0000') },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`reviewed ${REVIEWED}, but the checkout is now at moved0000`);
    expect(result.gh.some(call => call.includes('--method'))).toBe(false);
  });
});

describe('setPrDraft into draft uses the selected source', () => {
  const script = '../../scripts/__tests__/mark-pr-draft';
  it('converts through gh and reads back draft state', () => {
    const result = runPackScript(script, { source: 'gh', gh: { pr: { isDraft: false } } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ is_draft: true, state: 'open' });
    expect(result.gh).toContain('pr ready 42 --repo ghe.example.com/example/repo --undo');
  });
  it.each(['CLOSED', 'MERGED'] as const)('refuses %s without a write', state => {
    const result = runPackScript(script, { source: 'gh', gh: { pr: { state } } });
    expect(result.code).not.toBe(0);
    expect(result.gh.some(call => call.startsWith('pr ready'))).toBe(false);
  });
  it('does not write for an already-draft PR', () => {
    const result = runPackScript(script, { source: 'gh' });
    expect(result.code).toBe(0);
    expect(result.gh.some(call => call.startsWith('pr ready'))).toBe(false);
  });
  it('fails when gh conversion does not read back', () => {
    const result = runPackScript(script, { source: 'gh', gh: { pr: { isDraft: false }, writeLost: true } });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('does not report an open draft');
  });
  it('calls pr.draft through forge without gh', () => {
    const result = runPackScript(script, {
      source: 'forge',
      forge: {
        kind: 'fake',
        response: forgeOperation('pr.draft', {
          target: PR,
          outcome: 'applied',
          changed: true,
          pr: forgePrRecord(),
        }),
      },
    });
    expect(result.code).toBe(0);
    expect(result.gh).toEqual([]);
    expect(result.forge[0]).toContain('forge pr.draft --json --data-file');
    expect(JSON.parse(result.forgeRequests[0]).ref).toEqual(PR);
    expect(JSON.parse(result.stdout)).toMatchObject({ is_draft: true });
  });
  it.each(['refused', 'verification_failed', 'outcome_unknown'] as const)(
    'surfaces %s with no fallback',
    outcome => {
      const result = runPackScript(script, {
        source: 'forge',
        forge: {
          kind: 'fake',
          response: forgeFailure('pr.draft', outcome, 'unsupported or unverifiable conversion'),
        },
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(outcome);
      expect(result.gh).toEqual([]);
    }
  );
});
