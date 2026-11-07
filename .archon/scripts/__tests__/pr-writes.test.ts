/**
 * The pack's pull-request writes, through the forge.
 *
 * Fixtures stub these nodes, so only a subprocess run can observe what they
 * actually write, and whether a write that did
 * not read back is reported as a failure rather than a delivery.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DESCRIPTION_SECTION } from '../../workflows/sdlc/.shared/pr';
import { trackTempRoots } from './temp-roots';
import {
  PACK,
  PR,
  PR_URL,
  forgeCalls,
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
    ...rest,
    ...(forgeAt ? { forge: forgeAt(head) } : {}),
    cwd,
    tracker: { ...rest.tracker, pr: { headRefOid: head, ...rest.tracker?.pr } },
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
  it('continues without a publication record when no description is prepared', () => {
    for (const existing of [42, null]) {
      const result = publishPr({
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

  it('refuses another create while the earlier write is unresolved', () => {
      const result = publishPr({
        artifacts: { 'pr-create-started': JSON.stringify({ repo: PR.repo }) },
        tracker: { noOpenPr: true },
        forge: { kind: 'fake', response: forgeOperation('pr.view', null) },
      });
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('a previous PR create is unresolved');
      expect(result.forge.some(call => call.includes('forge pr.create'))).toBe(false);
    }
  );

  it('reconciles a previously started create when its PR is visible', () => {
      const result = publishPr({
        artifacts: { 'pr-create-started': JSON.stringify({ repo: PR.repo }) },
        tracker: { pr: { headRefName: 'feature' } },
        forgeAt: head => ({
          kind: 'fake',
          response: forgeOperation('pr.view', { pr: forgePrRecord({ head_revision: head }) }),
        }),
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ number: 42 });
      expect(result.forge.some(call => call.includes('forge pr.create'))).toBe(false);
    }
  );

  it('refuses to open a pull request without a body, leaving no claim', () => {
    const result = publishPr({
      forge: { kind: 'fake', response: forgeOperation('pr.view', null) },
      tracker: { noOpenPr: true, pr: { headRefName: 'feature' } },
      prepareBody: false,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('prepare wrote no body');
    expect(result.forge.some(call => call.includes('forge pr.create'))).toBe(false);
    expect(existsSync(join(result.artifacts, 'pr-create-started'))).toBe(false);
  });

  it('requires the declared body before creating', () => {
    for (const leftover of ['', 'An old body']) {
      const result = publishPr({
        target: { existing: 42 },
        inputs: { INPUTS_BRANCH: 'selected', INPUTS_BODY: 'null' },
        tracker: { noOpenPr: true },
        forge: { kind: 'fake', response: forgeOperation('pr.view', null) },
        artifacts: { 'pr-body.md': leftover },
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('prepare wrote no body');
      expect(result.forge.some(call => call.includes('forge pr.create'))).toBe(false);
      expect(existsSync(join(result.artifacts, 'pr-create-started'))).toBe(false);
    }
  });

  it('reads the body before claiming a create', () => {
    for (const directory of [false, true]) {
      const result = publishPr({
        prepareBody: false,
        inputs: { INPUTS_BODY: JSON.stringify({ type: 'archon_artifact', run_id: 'run', path: 'pr-body.md' }) },
        artifacts: directory ? { 'pr-body.md/entry': 'a directory cannot be a PR body' } : {},
        tracker: { noOpenPr: true },
        forge: { kind: 'fake', response: forgeOperation('pr.view', null) },
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(directory ? 'EISDIR' : 'ENOENT');
      expect(result.forge.some(call => call.includes('forge pr.create'))).toBe(false);
      expect(existsSync(join(result.artifacts, 'pr-create-started'))).toBe(false);
    }
  });

  it('reuses the open pull request for that head instead of opening a second one', () => {
    const result = publishPr({ tracker: { pr: { headRefName: 'feature' } } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42 });
    expect(result.stderr).toContain('already has this head');
  });

  it('publishes through the plugin', () => {
    const result = publishPr({
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
    expect(result.forge[1]).toContain('forge pr.create --json --data-file');
    // The authored body travels in the request file, never on the command line.
    expect(result.forge.join(' ')).not.toContain('A body');
    expect(JSON.parse(result.forgeRequests[1]).body).toBe('A body');
  });

  it('reports a refused create as a refusal that wrote nothing', () => {
    const result = publishPr({
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
      tracker: { pr: { headRefName: 'feature' } },
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('already has this head');
  });

  it('keeps the created pull request when the host could not audit the write', () => {
    const result = publishPr({
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
      tracker: { pr: { headRefName: 'feature' } },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42 });
    expect(existsSync(join(result.artifacts, 'pr-body.md'))).toBe(false);
    expect(forgeCalls(result).map(call => call.op)).toEqual(['pr.view', 'pr.view']);
  });

  it('adopts a named pull request whose head repository differs only in case', () => {
    const result = publishPr({
      target: { headRepo: { host: PR.repo.host, path: 'Example/Repo' }, existing: 42 },
      tracker: { pr: { headRefName: 'feature' } },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42 });
  });

  it('refuses before pushing when prepare did not continue the pull request the caller named', () => {
    for (const existing of [null, 41]) {
      const result = publishPr({ target: { existing }, inputs: { INPUTS_PULL_REQUEST: '42' } });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('the caller named pull request 42 to continue');
    }
    const agreed = publishPr({
      target: { existing: 42 },
      inputs: { INPUTS_PULL_REQUEST: '42' },
      tracker: { pr: { headRefName: 'feature' } },
    });
    expect(agreed.code).toBe(0);
    // A caller with no pull request to continue binds null.
    expect(publishPr({ inputs: { INPUTS_PULL_REQUEST: 'null' } }).code).toBe(0);
  });

  it('pushes a continued pull request to its own head, not the branch prepare recorded', () => {
    const result = publishPr({
      target: { existing: 42, head: 'archon/task-local' },
      tracker: { pr: { headRefName: 'feature' } },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42 });
    expect(remoteHead(result.cwd, 'feature')).toBe(result.head);
    expect(remoteHead(result.cwd, 'archon/task-local')).toBe('');
  });

  // GitHub's pull request API can report the previous head after the branch moved.
  // The first `pr.view` is the read before the push; the next `stale` reads lag.
  const lagging = (stale: number) => `
const fakeSpawn = Bun.spawnSync.bind(Bun);
let views = 0;
Bun.sleepSync = () => {};
Object.defineProperty(Bun, 'spawnSync', { value: (argv, settings) => {
  const result = fakeSpawn(argv, settings);
  if (argv[argv.indexOf('forge') + 1] !== 'pr.view' || !argv.includes('forge')) return result;
  views++;
  if (views < 2 || views > 1 + ${String(stale)}) return result;
  const response = JSON.parse(String(result.stdout));
  response.result.value.pr.head_revision = 'stale';
  return { ...result, stdout: Buffer.from(JSON.stringify(response)) };
} });
`;

  it('waits for a continued pull request to report the pushed head before recording it', () => {
    const result = publishPr({
      target: { existing: 42 },
      tracker: { pr: { headRefName: 'feature' } },
      preload: lagging(3),
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42, head_revision: result.head });
  });

  it('refuses when a continued pull request never reports the pushed head', () => {
    const result = publishPr({
      target: { existing: 42 },
      tracker: { pr: { headRefName: 'feature' } },
      preload: lagging(100),
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`pushed ${result.head}, but pull request 42 still reports head stale`);
  });

  it.each(['CLOSED', 'MERGED'] as const)('refuses to push to a continued pull request that is %s', state => {
    const result = publishPr({ target: { existing: 42 }, tracker: { pr: { state } } });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`pull request 42 is ${state.toLowerCase()}; nothing is pushed`);
    expect(remoteHead(result.cwd, 'feature')).toBe('');
  });

  it('opens the pull request from the branch the caller named', () => {
    const result = publishPr({
      inputs: { INPUTS_BRANCH: 'build/7-an-issue-run12345' },
      tracker: { noOpenPr: true, pr: { headRefName: 'build/7-an-issue-run12345' } },
    });
    expect(result.code).toBe(0);
    expect(forgeCalls(result).find(call => call.op === 'pr.create')?.request.head).toBe('build/7-an-issue-run12345');
    expect(remoteHead(result.cwd, 'build/7-an-issue-run12345')).toBe(result.head);
    expect(remoteHead(result.cwd, 'feature')).toBe('');
  });

  it('a caller-named branch that already has an open pull request updates it, never opening another', () => {
    const result = publishPr({
      target: { head: 'archon/task-local' },
      prepareBody: false,
      inputs: { INPUTS_BRANCH: 'feature' },
      tracker: { pr: { headRefName: 'feature' } },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42 });
    expect(result.stderr).toContain('already has this head');
    expect(remoteHead(result.cwd, 'feature')).toBe(result.head);
  });

  it('opens its own pull request from the caller-named branch when prepare found one on another head', () => {
    const result = publishPr({
      target: { existing: 42 },
      inputs: { INPUTS_BRANCH: 'build/7-an-issue-run12345' },
      tracker: { noOpenPr: true, pr: { headRefName: 'feature' } },
    });
    expect(result.code).toBe(0);
    expect(forgeCalls(result).find(call => call.op === 'pr.create')?.request.head).toBe('build/7-an-issue-run12345');
    expect(remoteHead(result.cwd, 'build/7-an-issue-run12345')).toBe(result.head);
    expect(remoteHead(result.cwd, 'feature')).toBe('');
  });

  it('refuses a caller-selected branch without a body when an unnamed PR has another head', () => {
    const result = publishPr({
      target: { existing: 42 },
      prepareBody: false,
      inputs: { INPUTS_BRANCH: 'build/7-an-issue-run12345' },
      tracker: { noOpenPr: true, pr: { headRefName: 'feature' } },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('prepare wrote no body');
    expect(result.forge.some(call => call.includes('forge pr.create'))).toBe(false);
    expect(existsSync(join(result.artifacts, 'pr-create-started'))).toBe(false);
  });

  it('continues a named pull request on its own head even when the caller also selected a branch', () => {
    const result = publishPr({
      target: { existing: 42 },
      prepareBody: false,
      inputs: { INPUTS_PULL_REQUEST: '42', INPUTS_BRANCH: 'build/7-an-issue-run12345' },
      tracker: { pr: { headRefName: 'feature' } },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42 });
    expect(remoteHead(result.cwd, 'feature')).toBe(result.head);
    expect(remoteHead(result.cwd, 'build/7-an-issue-run12345')).toBe('');
  });

  it('fails loudly when the forge is unavailable', () => {
    const result = publishPr({ forge: { kind: 'no-host' } });
    expect(result.code).not.toBe(0);
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
    tracker: { ...rest.tracker, pr: { headRefName: 'feature', body: live, ...rest.tracker?.pr } },
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

  it('preserves fenced and inline marker examples', () => {
    const live = `Author text.  \n\n\`\`\`md\n${START}\nexample\n${END}\n\`\`\`\nInline: \`${START}\` and \`${END}\`.  \n\n`;
    const result = publishSection({
      live,
      forgeAt: head => ({ kind: 'fake', response: [
        forgeOperation('pr.view', { pr: forgePrRecord({ head_revision: head }), title: 'A title', body: live }),
        forgeOperation('pr.view', { pr: forgePrRecord({ head_revision: head }), title: 'A title', body: live }),
        forgeOperation('pr.view', { pr: forgePrRecord({ head_revision: head }), title: 'A title', body: live }),
        forgeOperation('pr.edit-body', { pr: forgePrRecord({ head_revision: head }) }),
      ] }),
    });
    expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
    const body = JSON.parse(result.forgeRequests.at(-1) ?? '{}').body;
    expect(body).toBe(`${live}${START}\n| case | ms |\n| --- | --- |\n| a | 12 |\n\n${END}\n`);
  });

  it.each(['```'])(
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
  });

  it('publishes and reads back the section when creating a pull request', () => {
    const result = publishSection({ target: { existing: null }, prepareBody: true, tracker: { noOpenPr: true } });
    expect({ code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
    expect(forgeCalls(result).map(call => call.op)).toContain('pr.create');
    expect(result.bodies).toEqual([`A body\n\n${START}\n| case | ms |\n| --- | --- |\n| a | 12 |\n\n${END}\n`]);
  });

  it('keeps a created PR in the failure report when its description edit fails', () => {
    const result = publishSection({ target: { existing: null }, prepareBody: true, tracker: { noOpenPr: true },
      forgeAt: head => ({ kind: 'fake', response: [
        forgeOperation('pr.view', null),
        forgeOperation('pr.create', { target: PR.repo, outcome: 'applied', changed: true, pr: forgePrRecord({ head_revision: head }) }),
        forgeOperation('pr.view', { pr: forgePrRecord({ head_revision: head }), title: 'A title', body: 'A body' }),
        forgeFailure('pr.edit-body', 'refused', 'edit unavailable'),
      ] }),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('edit unavailable');
    const report = runPackScript('deliver/scripts/report', {
      inputs: { INPUTS_OUTCOME: 'null' },
      artifacts: { 'pr-create-started': readFileSync(join(result.artifacts, 'pr-create-started'), 'utf8') },
    });
    expect(JSON.parse(report.stdout)).toMatchObject({ ready: false, reason: 'failed', pr_url: PR_URL });
  });

  it('replaces only the content between its markers', () => {
    const result = publishSection({ live: `Before.\n\n${START}\nold\n${END}\n\nAfter.` });
    expect(result.code).toBe(0);
    expect(result.bodies).toEqual([`Before.\n\n${START}\n| case | ms |\n| --- | --- |\n| a | 12 |\n\n${END}\n\nAfter.`]);
  });

  it('writes nothing when the section is already current', () => {
    const result = publishSection({ live: `Before.\n\n${START}\n| case | ms |\n| --- | --- |\n| a | 12 |\n\n${END}\n` });
    expect(result.code).toBe(0);
    expect(result.bodies).toEqual([]);
  });

  it('writes through the plugin', () => {
    const result = publishSection({
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
    expect(result.forge[3]).toContain('forge pr.edit-body --json --data-file');
    expect(JSON.parse(result.forgeRequests[3])).toEqual({
      ref: { repo: PR.repo, number: 42 },
      body: `Written by hand.\n\n${START}\n| case | ms |\n| --- | --- |\n| a | 12 |\n\n${END}\n`,
    });
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
});

/** The commit the `upstream` remote holds for a branch, or empty when it has none. */
function remoteHead(cwd: string, branch: string): string {
  const remote = spawnSync('git', ['ls-remote', 'upstream', `refs/heads/${branch}`], { cwd, encoding: 'utf8' });
  return remote.stdout.trim().split(/\s/)[0] ?? '';
}

function publishReview(options: ScriptOptions = {}): ScriptRun {
  return runPackScript('review/scripts/publish-review', {
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

/** The PR head the fake forge reports, and so the commit a passing round reviewed. */
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
    expect(first.comments).toEqual([{ issue: 42, body: `${MARKER}\nReviewed commit: \`${REVIEWED}\`\nVerdict: ready\nContract: open\n\n${REPORT}` }]);

    const second = publishReview({
      inputs: report,
      tracker: { comments: [{ id: 5, body: `${MARKER}\nRound 1: ready\n` }] },
    });
    expect(second.code).toBe(0);
    expect(forgeCalls(second).filter(call => call.op === 'comment.upsert').map(call => call.request.marker)).toEqual([MARKER]);
  });

  it('publishes nothing for a working-diff review and still reports the verdict', () => {
    const result = publishReview({ inputs: { ...report, INPUTS_PR: 'null' } });
    expect(result.code).toBe(0);
    expect(result.forge).toEqual([]);
    expect(JSON.parse(result.stdout)).toMatchObject({ ready: true, action: 'none' });
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
    expect(result.comments).toEqual([]);
  });

  it('publishes to the recorded pull request when the scope declaration agrees', () => {
    const result = publishReview({ inputs: { ...report, INPUTS_SCOPE: JSON.stringify(PR) } });
    expect(result.code).toBe(0);
    expect(forgeCalls(result).find(call => call.op === 'comment.upsert')?.request.ref).toEqual(PR);
  });

  it('upserts through the plugin, with the report in the request file', () => {
    const forge: ScriptOptions['forge'] = {
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
    };
    const result = publishReview({
      inputs: report,
      forge,
    });
    expect(result.code).toBe(0);
    const request = JSON.parse(result.forgeRequests[1]) as { marker: string; body: string };
    expect(request.marker).toBe(MARKER);
    expect(request.body.split('\n')[0]).toBe(MARKER);
    expect(request.body).toContain(REPORT);
    // The comment names the commit it reviewed from the round's own record, not the report text.
    expect(request.body.split('\n')[1]).toBe(`Reviewed commit: \`${REVIEWED}\``);
    expect(request.body.split('\n')[2]).toBe('Verdict: ready');
    // A Ready verdict whose review left an acceptance item open is stamped open, so no merge closes the issue on it.
    expect(request.body.split('\n')[3]).toBe('Contract: open');
    expect(result.forge.join(' ')).not.toContain(REPORT);

    // A review that left nothing open is stamped complete: only that lets a merge close the issue.
    const complete = publishReview({
      inputs: { ...report, INPUTS_CONTRACT_LEFT: '[]' },
      forge,
    });
    expect(complete.code).toBe(0);
    const completeRequest = JSON.parse(complete.forgeRequests[1]) as { body: string };
    expect(completeRequest.body.split('\n')[3]).toBe('Contract: complete');
  });

  it('still reports the verdict when the host could not audit the comment write', () => {
    const result = publishReview({
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
// rate limit) must not end a run that has done hours of work. The repeat starts
// from the marker read, so a first attempt that landed is found when the next
// listing shows it; a listing that lags behind it lets the repeat post again.
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
    expect(result.comments).toEqual([]);
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
    expect(result.comments).toEqual([]);
  });
});

