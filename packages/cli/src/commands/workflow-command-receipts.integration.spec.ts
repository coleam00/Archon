import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const temp = trackTempRoots();
const cli = resolve(import.meta.dir, '../cli.ts');

test('real engine launch, sealed gate, process restart, decision replay and exact resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archon-command-receipts-'));
  temp(root);
  const project = join(root, 'project');
  await mkdir(join(project, '.archon/workflows'), { recursive: true });
  await writeFile(
    join(project, '.archon/workflows/receipt.yaml'),
    `name: receipt
description: Deterministic receipt integration.
interactive: true
nodes:
  - id: prepare
    bash: echo original-evidence
  - id: review
    depends_on: [prepare]
    approval:
      message: Review $prepare.output
      decisions: [{ id: approve }, { id: reject }]
  - id: finish
    depends_on: [review]
    bash: echo completed-after-review
`
  );
  async function invoke(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const child = Bun.spawn(
      [
        process.execPath,
        cli,
        'workflow',
        ...args,
        '--cwd',
        project,
        '--folder',
        ...(args[0] === 'resume' ? [] : ['--json']),
      ],
      {
        cwd: project,
        env: {
          ...process.env,
          ARCHON_HOME: join(root, 'home'),
          DATABASE_URL: '',
          TELEMETRY_DISABLED: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }
  const intent = await invoke(['launch-intent', 'receipt', 'test']);
  expect(intent.code, intent.stderr + intent.stdout).toBe(0);
  const digest = (JSON.parse(intent.stdout) as { payloadDigest: string }).payloadDigest;
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  const launched = await invoke([
    'run',
    'receipt',
    'test',
    '--launch-key',
    'one',
    '--launch-payload-digest',
    digest,
  ]);
  expect(launched.code, launched.stderr + launched.stdout).toBe(0);
  const status = await invoke(['launch-status', 'one']);
  const state = JSON.parse(status.stdout) as { receipt: { runId: string }; status: string };
  expect(state.status, intent.stderr + launched.stderr + launched.stdout).toBe('paused');
  const runId = state.receipt.runId;
  const detail = await invoke(['get', runId]);
  const parsed = JSON.parse(detail.stdout) as {
    run?: { metadata: { approval: { occurrenceId: string; evidenceDigest: string } } };
    metadata?: { approval: { occurrenceId: string; evidenceDigest: string } };
  };
  const metadata = parsed.run?.metadata ?? parsed.metadata;
  if (!metadata) throw new Error('Missing run metadata: ' + detail.stdout);
  const gate = metadata.approval;
  expect(gate.occurrenceId).toBeString();
  const wronglyRouted = await invoke([
    'approve',
    runId,
    '--expected-occurrence',
    gate.occurrenceId,
  ]);
  expect(wronglyRouted.code).toBe(1);
  expect(JSON.parse(wronglyRouted.stdout)).toMatchObject({ ok: false });
  const wrongDigest = await invoke([
    'respond',
    runId,
    'approve',
    '--command-id',
    'stale-decision',
    '--expected-occurrence',
    gate.occurrenceId,
    '--expected-evidence-digest',
    '0'.repeat(64),
  ]);
  expect(wrongDigest.code).toBe(1);
  expect(JSON.parse(wrongDigest.stdout)).toMatchObject({ ok: false, code: 'stale_gate' });
  const decision = [
    'respond',
    runId,
    'approve',
    '--command-id',
    'decision',
    '--expected-occurrence',
    gate.occurrenceId,
    '--expected-evidence-digest',
    gate.evidenceDigest,
  ];
  const accepted = await invoke(decision);
  expect(accepted.code, accepted.stderr + accepted.stdout).toBe(0);
  expect(JSON.parse(accepted.stdout)).toMatchObject({ ok: true, runId });
  const resumed = await invoke(['resume', runId]);
  expect(resumed.code, resumed.stderr + resumed.stdout).toBe(0);
  expect(JSON.parse((await invoke(decision)).stdout)).toEqual(JSON.parse(accepted.stdout));
  const replay = await invoke([
    'run',
    'receipt',
    'test',
    '--launch-key',
    'one',
    '--launch-payload-digest',
    digest,
  ]);
  expect(replay.code, replay.stderr + replay.stdout).toBe(0);
  expect(JSON.parse((await invoke(['launch-status', 'one'])).stdout)).toMatchObject({
    receipt: { runId },
    status: 'completed',
  });
  const conflict = await invoke([
    'run',
    'receipt',
    'changed brief',
    '--launch-key',
    'one',
    '--launch-payload-digest',
    digest,
  ]);
  expect(conflict.code).toBe(1);
  expect(JSON.parse(conflict.stdout)).toMatchObject({
    ok: false,
    code: 'command_payload_conflict',
  });
  const forged = await invoke([
    'run',
    'receipt',
    'test',
    '--launch-key',
    'forged',
    '--launch-payload-digest',
    '0'.repeat(64),
  ]);
  expect(forged.code).toBe(1);
  expect(JSON.parse(forged.stdout)).toMatchObject({ ok: false, code: 'launch_payload_mismatch' });
  const detached = await invoke(['run', 'receipt', 'test', '--detach']);
  expect(detached.code).toBe(1);
  expect(JSON.parse(detached.stdout)).toMatchObject({ ok: false });
  const runs = JSON.parse((await invoke(['runs'])).stdout) as { runs: unknown[] };
  expect(runs.runs).toHaveLength(1);
}, 60_000);
