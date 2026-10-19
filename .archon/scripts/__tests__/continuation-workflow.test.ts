import { expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PACK,
  PR,
  forgeOperation,
  forgePrRecord,
  gitCheckout,
  hostCli,
} from './deliver-checks-harness';
import { trackTempRoots } from './temp-roots';

const track = trackTempRoots();

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout.trim();
}

it.each([
  ['build-queue', 'deliver'],
  ['ship', 'deliver'],
  ['ship', 'continue'],
  ['ship', 'investigate'],
  ['ship', 'plan'],
] as const)(
  '%s %s delivery enters at the remote PR head',
  (entry, route) => {
    const cwd = gitCheckout({}, track);
    const head = git(cwd, 'rev-parse', 'HEAD');
    git(cwd, 'push', '-q', 'upstream', 'feature');
    git(cwd, 'checkout', '-q', '-b', 'continuation', 'dev');
    expect(git(cwd, 'rev-parse', 'HEAD')).not.toBe(head);

    const source = track(mkdtempSync(join(tmpdir(), 'archon-continuation-source-')));
    const pack = join(cwd, '.archon/workflows/sdlc');
    cpSync(PACK, pack, { recursive: true });
    const callerFile = join(pack, entry, `archon-${entry}${entry === 'ship' ? '-block' : ''}.yaml`);
    const caller = Bun.YAML.parse(readFileSync(callerFile, 'utf8')) as {
      nodes: { id: string; depends_on?: string[]; [key: string]: unknown }[];
    };
    // Exercise an ordering where delivery wins ties: YAML order cannot substitute
    // for the dependency that must keep it behind checkout.
    caller.nodes.reverse();
    const checkout = caller.nodes.find(node => node.id === 'checkout');
    if (!checkout) throw new Error('continuation has no checkout');
    // Model a slow checkout prerequisite so unrelated branches cannot accidentally
    // serialize delivery ahead of it in the simulator's synchronous execution.
    let dependencies = checkout.depends_on;
    for (let index = 0; index < 4; index++) {
      const id = `checkout-delay-${index}`;
      caller.nodes.push({ id, bash: 'true', depends_on: dependencies });
      dependencies = [id];
    }
    checkout.depends_on = dependencies;
    writeFileSync(callerFile, JSON.stringify(caller));
    // Replace only the called block with a delivery-entry probe. The caller's real
    // graph and checkout script must prepare the worktree before this code runs.
    const boundary =
      entry === 'build-queue' ? 'ship/archon-ship-block.yaml' : 'deliver/archon-deliver-block.yaml';
    const block = Bun.YAML.parse(readFileSync(join(pack, boundary), 'utf8')) as Record<
      string,
      unknown
    >;
    const observed = join(source, 'delivery-head');
    const output = {
      delivered: true,
      ready: true,
      reason: 'ready',
      pr_url: forgePrRecord().url,
      summary: 'delivered',
    };
    block.nodes = [
      {
        id: 'report',
        script: `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(observed)}, Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout);\nconsole.log(${JSON.stringify(JSON.stringify(output))});`,
        runtime: 'bun',
        output_format: {
          type: 'object',
          properties: {
            ready: { type: 'boolean' },
            delivered: { type: 'boolean' },
            summary: { type: 'string' },
            reason: { type: 'string' },
            pr_url: { type: 'string' },
          },
          required: ['ready', 'delivered'],
        },
      },
    ];
    writeFileSync(join(pack, boundary), JSON.stringify(block));

    const fixture = Bun.YAML.parse(
      readFileSync(join(PACK, 'build-queue/fixtures/continue.stubs.yaml'), 'utf8')
    ) as Record<string, unknown>;
    const stubs: Record<string, unknown> =
      entry === 'build-queue'
        ? { ...fixture }
        : Object.fromEntries(
            Object.entries(fixture)
              .filter(([key]) => key.startsWith('ship__'))
              .map(([key, value]) => [key.slice('ship__'.length), value])
          );
    delete stubs.fixture;
    delete stubs['exec-code'];
    delete stubs.checkout;
    if (entry === 'build-queue') {
      stubs.facts = {
        ...(fixture.facts as Record<string, unknown>),
        item: PR,
        continues: PR.number,
      };
    } else {
      stubs.continuation = PR;
      stubs.triage__triage = {
        ...(stubs.triage__triage as Record<string, unknown>),
        decision: {
          contract: 'READY',
          route,
          ...(route === 'continue' ? { pull_request: PR.number } : {}),
        },
      };
      stubs.inv__investigate = {
        verdict: 'rooted',
        summary: 'cause established',
        report: { type: 'archon_artifact', run_id: 'fixture-run', path: 'investigation.md' },
      };
      stubs.intel = 'No usage data needed';
      stubs.planned__plan = {
        ready: true,
        open_questions: [],
        summary: 'ready to implement',
        report: { type: 'archon_artifact', run_id: 'fixture-run', path: 'plan.md' },
      };
    }
    const stubFile = join(source, 'stubs.json');
    writeFileSync(stubFile, JSON.stringify(stubs));
    const forge = join(source, 'forge.ts');
    writeFileSync(
      forge,
      `const original = Bun.spawnSync.bind(Bun);
Object.defineProperty(Bun, 'spawnSync', { value: (argv, options) => argv.includes('pr.view') ? { exitCode: 0, stdout: Buffer.from(${JSON.stringify(forgeOperation('pr.view', { pr: forgePrRecord({ head_revision: head }), title: '', body: '' }))}), stderr: Buffer.from('') } : original(argv, options) });`
    );
    const run = spawnSync(
      hostCli()[0],
      [
        ...hostCli().slice(1),
        'workflow',
        'run',
        entry === 'build-queue' ? 'archon-build-queue' : 'archon-ship-block',
        '--cwd',
        cwd,
        '--dry-run',
        '--exec-code',
        '--stubs',
        stubFile,
        '--json',
        ...(entry === 'ship' ? ['--input', `pull_request=${PR.number}`] : []),
      ],
      {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ARCHON_SDLC_FORGE: 'forge', BUN_OPTIONS: `--preload=${forge}` },
      }
    );
    expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toMatchObject({
      status: 0,
    });
    expect(readFileSync(observed, 'utf8').trim()).toBe(head);
  },
  30_000
);

it.each([
  [
    'no_action',
    { contract: 'NO_ACTION', closure: { kind: 'delivered', url: 'https://example.com/pr/3' } },
    null,
  ],
  ['blocked', { contract: 'BLOCKED', blocked_reason: 'missing access', blocked_by: [] }, null],
  [
    'needs_contract',
    {
      contract: 'NEEDS_CONTRACT_WORK',
      proposed_edits: { title: 'Work', body: 'Acceptance needed' },
    },
    null,
  ],
  ['refuted', { contract: 'READY', route: 'investigate' }, 'refuted'],
  ['not_rooted', { contract: 'READY', route: 'investigate' }, 'inconclusive'],
  ['ask', { contract: 'READY', route: 'plan' }, null],
] as const)(
  'standalone ship preserves %s with and without a caller PR',
  (reason, decision, verdict) => {
    const root = track(mkdtempSync(join(tmpdir(), 'archon-stop-continuation-')));
    cpSync(PACK, join(root, '.archon/workflows/sdlc'), { recursive: true });
    const fixture = Bun.YAML.parse(
      readFileSync(join(PACK, 'ship/fixtures/plan-blocked.stubs.yaml'), 'utf8')
    ) as Record<string, unknown>;
    delete fixture.fixture;
    delete fixture['exec-code'];
    const stubs = {
      ...fixture,
      triage__triage: {
        ...(fixture.triage__triage as Record<string, unknown>),
        decision,
      },
      continuation: PR,
      inv__investigate: {
        verdict,
        summary: 'No implementation admitted',
        report: { type: 'archon_artifact', run_id: 'fixture-run', path: 'investigation.md' },
      },
    };
    const stubFile = join(root, 'stubs.json');
    writeFileSync(stubFile, JSON.stringify(stubs));
    const observed = join(root, 'pr-read');
    const preload = join(root, 'forge.ts');
    writeFileSync(
      preload,
      `import { writeFileSync } from 'node:fs';
const original = Bun.spawnSync.bind(Bun);
Object.defineProperty(Bun, 'spawnSync', { value: (argv, options) => {
  if (!argv.includes('pr.view')) return original(argv, options);
  writeFileSync(${JSON.stringify(observed)}, 'read');
  return { exitCode: 0, stdout: Buffer.from(${JSON.stringify(
    forgeOperation('pr.view', {
      pr: forgePrRecord({
        head_repo: { host: PR.repo.host, path: 'fork/repo' },
        maintainer_can_modify: false,
      }),
      title: '',
      body: '',
    })
  )}), stderr: Buffer.alloc(0) };
} });`
    );
    for (const caller of ['', String(PR.number)]) {
      const run = spawnSync(
        hostCli()[0],
        [
          ...hostCli().slice(1),
          'workflow',
          'run',
          'archon-ship-block',
          '--cwd',
          root,
          '--dry-run',
          '--exec-code',
          '--stubs',
          stubFile,
          '--json',
          '--input',
          `pull_request=${caller}`,
        ],
        {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, ARCHON_SDLC_FORGE: 'forge', BUN_OPTIONS: `--preload=${preload}` },
        }
      );
      expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toMatchObject({
        status: 0,
      });
      const result = JSON.parse(run.stdout) as { outcome: string; summary: string };
      expect(result.outcome).toBe('completed');
      expect(JSON.parse(result.summary)).toMatchObject({ delivered: false, reason, pr_url: '' });
      expect(existsSync(observed)).toBe(false);
    }
  },
  30_000
);
