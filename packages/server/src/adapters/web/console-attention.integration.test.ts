import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OpenAPIHono } from '@hono/zod-openapi';
import { closeDatabase, resetDatabase } from '@archon/core/db/connection';
import { ConversationLockManager } from '@archon/core/utils/conversation-lock';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import { registerApiRoutes } from '../../routes/api';
import { runsNeedingAttentionResponseSchema } from '../../routes/schemas/workflow.schemas';
import { WebAdapter } from '../web';
import { DashboardEventPoller } from './dashboard-event-poller';
import { MessagePersistence } from './persistence';
import { SSETransport, DASHBOARD_STREAM } from './transport';
import { WorkflowEventBridge } from './workflow-bridge';

// Declared approvals are interactive-class and the CLI refuses --detach for them.
// The attention workflow exercises the detached child; the approval is a foreground control.
test(
  'an open dashboard observes a real detached CLI attention wait and a CLI approval',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'archon-console-attention-')));
    const savedHome = process.env.ARCHON_HOME;
    const savedDatabase = process.env.DATABASE_URL;
    process.env.ARCHON_HOME = join(root, 'home');
    process.env.DATABASE_URL = '';
    resetDatabase();
    const transport = new SSETransport();
    const poller = new DashboardEventPoller();
    const app = new OpenAPIHono();
    const adapter = new WebAdapter(
      transport,
      new MessagePersistence((id, event) => transport.emit(id, event)),
      new WorkflowEventBridge(transport)
    );
    registerApiRoutes(app, adapter, new ConversationLockManager());
    const intervalMs = 1000;
    const observed = new Map<string, { kind: string; occurrence?: string }>();
    const observerErrors: unknown[] = [];
    transport.registerStream(DASHBOARD_STREAM, {
      closed: false,
      close: async () => {},
      writeSSE: async ({ data }) => {
        const event: unknown = JSON.parse(data);
        if (
          typeof event !== 'object' ||
          event === null ||
          !('type' in event) ||
          event.type !== 'workflow_status' ||
          !('status' in event) ||
          event.status !== 'paused'
        )
          return;
        try {
          const response = await app.request('/api/runs/attention');
          expect(response.status).toBe(200);
          const inbox = runsNeedingAttentionResponseSchema.parse(await response.json());
          for (const run of inbox.runs) {
            const attention = run.attention;
            if (attention?.kind === 'action_required' || attention?.kind === 'awaiting_response') {
              if (!observed.has(run.workflow_name))
                observed.set(run.workflow_name, {
                  kind: attention.kind,
                  occurrence: attention.occurrence,
                });
            }
          }
        } catch (error) {
          observerErrors.push(error);
        }
      },
    });
    poller.start(transport, intervalMs);
    try {
      expect(
        runsNeedingAttentionResponseSchema.parse(
          await (await app.request('/api/runs/attention')).json()
        ).runs
      ).toEqual([]);
      for (const [name, body, detached] of [
        ['runtime-attention', 'wait:\n      attention: Rotate then resume', true],
        ['runtime-approval', 'approval:\n      message: Approve runtime control', false],
      ] as const) {
        const project = join(root, name);
        await mkdir(join(project, '.archon', 'workflows'), { recursive: true });
        await writeFile(
          join(project, '.archon', 'workflows', `${name}.yaml`),
          `name: ${name}\ndescription: Console cross-process proof\nnodes:\n  - id: hold\n    ${body}\n`
        );
        const child = Bun.spawn(
          [
            process.execPath,
            resolve(import.meta.dir, '../../../../cli/src/cli.ts'),
            'workflow',
            'run',
            name,
            '--cwd',
            project,
            '--folder',
            '--json',
            ...(detached ? ['--detach'] : []),
            'Verify console attention against a scratch install.',
          ],
          {
            cwd: project,
            env: { ...process.env, DATABASE_URL: '', ARCHON_DISABLE_TELEMETRY: 'true' },
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
          }
        );
        const [exit, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ exit, stderr }).toMatchObject({ exit: 0 });
        if (detached) {
          const launch: unknown = JSON.parse(stdout);
          expect(launch).toHaveProperty('runId');
        }
        const deadline = Date.now() + 15_000;
        while (!observed.has(name) && observerErrors.length === 0 && Date.now() < deadline)
          await Bun.sleep(20);
        expect(observerErrors).toEqual([]);
        expect(observed.get(name)?.kind).toBe(detached ? 'action_required' : 'awaiting_response');
        if (detached && !observed.get(name)?.occurrence)
          throw new Error('No wait occurrence observed');
      }
    } finally {
      poller.stop();
      transport.stop();
      await closeDatabase();
      if (savedHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = savedHome;
      if (savedDatabase === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = savedDatabase;
      await removeTempTree(root);
    }
  },
  testTimeout(60_000)
);
