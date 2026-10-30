import { expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { mockWorkflowRun } from '../../test/mocks/workflow-run';
import { createRunResourceRelease } from './run-verification-images';

const trackTempRoot = trackTempRoots();

test.skipIf(process.env.ARCHON_TEST_DOCKER !== '1')(
  'terminal host releases only unused run-labelled Docker images',
  async () => {
    const runId = `verification-${crypto.randomUUID()}`;
    const prefix = `archon-${runId}`;
    const context = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-verification-')));
    const containers: string[] = [];
    const base = `${prefix}:base`;
    const unused = `${prefix}:unused`;
    const second = `${prefix}:second`;
    const other = `${prefix}:other`;
    const stopped = `${prefix}:stopped`;
    const running = `${prefix}:running`;
    const tags = [base, unused, second, other, stopped, running];
    const docker = async (...args: string[]): Promise<string> => {
      const child = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) throw new Error(`docker ${args[0]} ${args[1]}: ${stderr}`);
      return stdout.trim();
    };
    const imageId = async (tag: string): Promise<string | null> => {
      const child = Bun.spawn(['docker', 'image', 'inspect', '--format', '{{.Id}}', tag], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, , code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return code === 0 ? stdout.trim() : null;
    };
    const bases = new Map<string, string | null>();
    const baseTags = await docker(
      'image',
      'ls',
      '--format',
      '{{.Repository}}:{{.Tag}}',
      '--filter',
      'reference=alpine:*',
      '--filter',
      'reference=oven/bun:*'
    );
    for (const tag of baseTags.split('\n').filter(Boolean)) bases.set(tag, await imageId(tag));
    const executableBase = bases.keys().next().value;
    if (!executableBase)
      throw new Error('Docker fixture needs a local alpine or oven/bun image; it never pulls');
    try {
      await writeFile(join(context, 'sentinel'), runId);
      await writeFile(join(context, 'Dockerfile'), 'FROM scratch\nCOPY sentinel /sentinel\n');
      await docker('build', '-t', base, context);
      await writeFile(
        join(context, 'Dockerfile'),
        `FROM ${base}\nLABEL archon.run_id="${runId}"\n`
      );
      await docker('build', '-t', unused, context);
      await docker('tag', unused, second);
      await writeFile(
        join(context, 'Dockerfile'),
        `FROM ${base}\nLABEL archon.run_id="${runId}-other"\n`
      );
      await docker('build', '-t', other, context);
      for (const [tag, name] of [
        [stopped, 'stopped'],
        [running, 'running'],
      ] as const) {
        await writeFile(
          join(context, 'Dockerfile'),
          `FROM ${executableBase}\nLABEL archon.run_id="${runId}"\nLABEL fixture="${name}"\n`
        );
        await docker('build', '-t', tag, context);
        const container = `${prefix}-${name}`;
        containers.push(container);
        await docker('create', '--name', container, tag, 'sleep', '300');
        if (name === 'running') await docker('start', container);
        expect(await docker('inspect', '--format', '{{.State.Running}}', container)).toBe(
          name === 'running' ? 'true' : 'false'
        );
      }
      const before = new Map<string, string | null>();
      for (const tag of [base, other, stopped, running]) before.set(tag, await imageId(tag));
      const run = {
        ...mockWorkflowRun,
        id: runId,
        status: 'completed' as const,
        metadata: { execution_owner: { host: hostname(), pid: process.pid } },
      };
      await createRunResourceRelease({ getWorkflowRun: async () => run })(runId);
      expect(await imageId(unused)).toBeNull();
      expect(await imageId(second)).toBeNull();
      for (const [tag, expected] of [...bases, ...before])
        expect(await imageId(tag)).toBe(expected);
    } finally {
      for (const container of containers) await docker('rm', '--force', container);
      for (const tag of [...tags].reverse())
        if (await imageId(tag)) await docker('image', 'rm', '--no-prune', tag);
    }
  },
  60_000
);
