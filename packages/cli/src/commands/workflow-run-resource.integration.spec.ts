import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import { createFileWorkflowHost } from '@archon/core/workflows/file-host';

const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  for (const root of roots.splice(0)) await removeTempTree(root);
});

async function until(check: () => boolean | Promise<boolean>, evidence: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out: ${evidence}`);
}

for (const store of ['database', 'files'] as const) {
  test(`CLI resource admission waits, refuses before detached ack, and includes hold one slot (${store})`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'archon-cli-resource-'));
    roots.push(root);
    const home = join(root, 'home');
    mkdirSync(home);
    writeFileSync(join(home, 'config.yaml'), `store: ${store}\n`);
    const holder = join(root, 'holder');
    const contender = join(root, 'contender');
    const marker = join(root, 'holding');
    const release = join(root, 'release');
    for (const cwd of [holder, contender])
      mkdirSync(join(cwd, '.archon', 'workflows'), { recursive: true });
    writeFileSync(
      join(holder, '.archon/workflows/hold.yaml'),
      `name: hold\ndescription: Hold resource\nresource: {name: build, capacity: 1}\nworktree: {enabled: false}\nnodes:\n  - id: hold\n    bash: ${JSON.stringify(`touch '${marker}'; while [ ! -f '${release}' ]; do sleep 0.05; done`)}\n`
    );
    writeFileSync(
      join(contender, '.archon/workflows/leaf.yaml'),
      'name: leaf\ndescription: Included block\nresource: {name: build, capacity: 1}\nnodes:\n  - id: done\n    bash: echo included\n'
    );
    writeFileSync(
      join(contender, '.archon/workflows/probe.yaml'),
      'name: probe\ndescription: Compete for resource\nresource: {name: build, capacity: 1}\nworktree: {enabled: false}\nnodes:\n  - id: block\n    include: leaf\n'
    );
    function start(cwd: string, name: string, flags: string[] = []) {
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, '../cli.ts'),
          'workflow',
          'run',
          name,
          '--folder',
          '--cwd',
          cwd,
          ...flags,
        ],
        {
          env: {
            ...process.env,
            ARCHON_HOME: home,
            DATABASE_URL: '',
            DEFAULT_AI_ASSISTANT: '',
            ARCHON_TELEMETRY_DISABLED: '1',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        }
      );
      children.push(child);
      const output = Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { child, output };
    }
    const first = start(holder, 'hold');
    await until(() => existsSync(marker), 'holder executes');
    const db =
      store === 'database' ? new Database(join(home, 'archon.db'), { readonly: true }) : undefined;
    const fileHost =
      store === 'files' ? await createFileWorkflowHost(join(home, 'store')) : undefined;
    async function queued() {
      if (db)
        return db
          .query<{ id: string }, []>(
            "SELECT id FROM remote_agent_resource_start_requests WHERE status = 'queued'"
          )
          .all();
      const { runs } = await fileHost!.deps.store.listWorkflowRuns({ limit: 20 });
      const requests = await Promise.all(
        runs.map(run => fileHost!.deps.store.getResourceStartRequest(run.id))
      );
      return requests.filter(request => request?.status === 'queued');
    }
    async function completed(runId: string): Promise<boolean> {
      if (db)
        return (
          db
            .query<{ status: string }, [string]>(
              'SELECT status FROM remote_agent_workflow_runs WHERE id = ?'
            )
            .get(runId)?.status === 'completed'
        );
      return (await fileHost!.deps.store.getWorkflowRun(runId))?.status === 'completed';
    }
    const detachedRuns: string[] = [];
    try {
      for (const flags of [['--no-wait'], ['--no-wait', '--detach', '--json']]) {
        const refused = start(contender, 'probe', flags);
        expect(await refused.child.exited).not.toBe(0);
        const [stdout, stderr] = await refused.output;
        expect(stdout + stderr).toContain("Resource 'build' did not admit this start");
        if (flags.includes('--json')) {
          expect(JSON.parse(stdout).ok).toBe(false);
          expect(stdout).not.toContain('"detached":true');
        }
      }
      const interrupted = start(contender, 'probe');
      await until(async () => (await queued()).length === 1, 'interruptible request queued');
      interrupted.child.kill('SIGINT');
      expect(await interrupted.child.exited).not.toBe(0);
      expect(await queued()).toHaveLength(0);
      const killed = start(contender, 'probe');
      await until(async () => (await queued()).length === 1, 'abrupt-death request queued');
      const killedId = (await queued())[0]!.id;
      killed.child.kill('SIGKILL');
      expect(await killed.child.exited).not.toBe(0);
      expect((await queued())[0]?.id).toBe(killedId);
      expect(first.child.exitCode).toBeNull();
      async function trigger(action: string) {
        const child = Bun.spawn(
          [process.execPath, join(import.meta.dir, '../cli.ts'), 'trigger', action, killedId],
          {
            env: {
              ...process.env,
              ARCHON_HOME: home,
              DATABASE_URL: '',
              DEFAULT_AI_ASSISTANT: '',
              ARCHON_TELEMETRY_DISABLED: '1',
            },
            stdout: 'pipe',
            stderr: 'pipe',
          }
        );
        children.push(child);
        const output = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(await child.exited, output.join('\n')).toBe(0);
        return JSON.parse(output[0]);
      }
      expect((await trigger('inspect')).status).toBe('queued');
      expect((await trigger('withdraw')).withdrawn).toBe(true);
      expect(await queued()).toHaveLength(0);
      const detached = start(contender, 'probe', ['--detach', '--json']);
      expect(await detached.child.exited).toBe(0);
      const ack = JSON.parse((await detached.output)[0]) as { ok: boolean; runId: string };
      expect(ack.ok).toBe(true);
      detachedRuns.push(ack.runId);
      await until(async () => (await queued()).length === 1, 'detached child owns waiting');
      const second = start(contender, 'probe');
      await until(async () => (await queued()).length === 2, 'native request queued');
      expect(first.child.exitCode).toBeNull();
      expect(second.child.exitCode).toBeNull();
      writeFileSync(release, 'release');
      expect(await first.child.exited, (await first.output).join('\n')).toBe(0);
      expect(await second.child.exited, (await second.output).join('\n')).toBe(0);
      expect((await second.output)[1]).toContain("Waiting for resource 'build'");
      await until(() => completed(ack.runId), 'detached resource waiter completes');
      const accepted = start(contender, 'probe', ['--no-wait', '--detach', '--json']);
      expect(await accepted.child.exited, (await accepted.output).join('\n')).toBe(0);
      const acceptedAck = JSON.parse((await accepted.output)[0]) as { ok: boolean; runId: string };
      expect(acceptedAck.ok).toBe(true);
      detachedRuns.push(acceptedAck.runId);
      await until(() => completed(acceptedAck.runId), 'detached no-wait accepted and completes');
      expect(await queued()).toHaveLength(0);
      if (db) {
        expect(
          db
            .query<{ count: number }, []>(
              "SELECT count(*) AS count FROM remote_agent_resource_start_requests WHERE status = 'admitted'"
            )
            .get()?.count
        ).toBe(4);
        expect(
          db
            .query<{ count: number }, []>(
              'SELECT count(*) AS count FROM remote_agent_workflow_runs'
            )
            .get()?.count
        ).toBe(8);
      }
    } finally {
      writeFileSync(release, 'release');
      await first.child.exited;
      for (const runId of detachedRuns)
        await until(() => completed(runId), 'detached owner releases fixture');
      db?.close();
    }
  }, 30_000);
}
