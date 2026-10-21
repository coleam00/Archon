// @archon-test-isolated
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import { recordNodeProcessTrees } from '@archon/workflows/subprocess';
import { makeTestResolvedWorkflow } from '@archon/workflows/test-utils';
import { startRunLiveOwner } from '../services/run-live-owner';
import { createFileWorkflowHost } from './file-host';

const roots = trackTempRoots();
const posix = process.platform === 'win32' ? test.skip : test;
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Cooperative fixture did not reach expected state');
    await Bun.sleep(20);
  }
}

function stopPid(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

for (const kind of ['bash', 'script'] as const) {
  posix(
    `cooperative cancellation reports completed ${kind} background work in result and event`,
    async () => {
      registerBuiltinProviders();
      const dir = roots(await mkdtemp(join(tmpdir(), 'archon-cooperative-')));
      const host = await createFileWorkflowHost(join(dir, 'store'));
      const engine = new InProcessWorkflowEngine({
        ...host.deps,
        loadConfig: async () => ({
          assistant: 'claude',
          baseBranch: 'main',
          assistants: { claude: {}, codex: {} },
          commands: {},
          defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
        }),
      });
      const background = join(dir, 'background');
      const active = join(dir, 'active');
      const first =
        kind === 'bash'
          ? {
              id: 'completed',
              bash: `sleep 60 </dev/null >/dev/null 2>&1 & echo $! > '${background}'`,
            }
          : {
              id: 'completed',
              runtime: 'bun',
              script: `const child = Bun.spawn(['/bin/sleep', '60'], {stdio: ['ignore', 'ignore', 'ignore']}); require('fs').writeFileSync(${JSON.stringify(background)}, String(child.pid)); child.unref();`,
            };
      const trees = recordNodeProcessTrees();
      const execution = engine.submit({
        platform: {
          sendMessage: async () => {},
          getPlatformType: () => 'test',
          getStreamingMode: () => 'batch',
        },
        conversationId: 'cooperative',
        origin: { conversationId: 'cooperative' },
        cwd: dir,
        userMessage: 'test cancellation',
        workflow: makeTestResolvedWorkflow({
          name: 'cooperative',
          nodes: [
            first,
            {
              id: 'active',
              depends_on: ['completed'],
              bash: `echo $$ > '${active}'; exec /bin/sleep 60`,
            },
          ],
        }),
      });
      let owner: Awaited<ReturnType<typeof startRunLiveOwner>> | undefined;
      try {
        await until(() => existsSync(active));
        const run = (await host.deps.store.listWorkflowRuns()).runs[0];
        if (!run) throw new Error('No run');
        owner = await startRunLiveOwner(run.id);
        const before = await host.deps.store.listWorkflowEvents(run.id);
        expect(
          before.some(
            event => event.event_type === 'node_completed' && event.step_name === 'completed'
          )
        ).toBe(true);
        const result = await host.operations.cancelWorkflow(run.id, { kind: 'operator' });
        expect(result).toMatchObject({ kind: 'cooperative', cancelled: true });
        expect(result.cleanupWarnings?.join('\n')).toContain('untracked background work');
        expect(result.cleanupWarnings?.join('\n')).toContain('lsof');
        const events = await host.deps.store.listWorkflowEvents(run.id);
        expect(
          events.find(event => event.event_type === 'workflow_cancelled')?.data.warnings
        ).toEqual(result.cleanupWarnings);
        process.kill(Number(readFileSync(background, 'utf8')), 0);
        await execution;
      } finally {
        await trees.end();
        trees.release();
        for (const file of [background, active]) {
          if (existsSync(file)) {
            stopPid(Number(readFileSync(file, 'utf8')));
          }
        }
        await execution;
        await owner?.close();
      }
    }
  );
}
