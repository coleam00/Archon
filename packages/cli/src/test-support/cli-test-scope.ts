import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { confirmProcessGroupsGone, terminateTree } from '@archon/paths/plugin-process';
import { isPidProvablyGone } from '@archon/paths/process-owner';
import { removeTempTree } from '@archon/paths/test-utils';

export class CliTestScope {
  private closed = false;
  private readonly children = new Map<Bun.Subprocess<'pipe', 'pipe', 'pipe'>, Promise<unknown>>();

  constructor(readonly root: string) {}

  get detachedPids(): string {
    return join(this.root, 'detached-pids');
  }

  async run(command: string[], cwd: string, env: NodeJS.ProcessEnv, input = '') {
    if (this.closed) throw new Error('CLI test scope is closed');
    const child = Bun.spawn(command, { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const settled = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    this.children.set(child, settled);
    child.stdin.write(input);
    child.stdin.end();
    const [output, error, code] = await settled;
    if (this.closed) throw new Error('CLI test scope is closed');
    return { output, error, code };
  }

  async close(): Promise<void> {
    this.closed = true;
    const children = [...this.children];
    for (const [child] of children) child.kill('SIGKILL');
    await Promise.all(children.map(([child]) => child.exited));
    await Promise.allSettled(children.map(([, settled]) => settled));
    this.children.clear();
    await this.stopDetachedChildren();
    await removeTempTree(this.root);
  }

  private async stopDetachedChildren(): Promise<void> {
    const stopped = new Set<number>();
    // An owner can record a detached node while teardown is stopping it.
    while (existsSync(this.detachedPids)) {
      const owners = readFileSync(this.detachedPids, 'utf8').trim().split('\n').map(Number);
      if (owners.some(pid => !Number.isSafeInteger(pid) || pid <= 0))
        throw new Error('Invalid detached test PID');
      const pending = owners.filter(pid => !stopped.has(pid));
      if (pending.length === 0) return;
      for (const pid of pending) await stopDetachedTree(pid);
      for (const pid of pending) {
        stopped.add(pid);
      }
    }
  }
}

async function stopDetachedTree(pid: number): Promise<void> {
  try {
    await terminateTree(pid);
  } catch (error) {
    if (process.platform === 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM')
      throw error;
    // macOS can refuse a group signal after leader exit. Process-list confirmation
    // below must still prove that no member survives before fixture removal.
  }
  if (process.platform !== 'win32') {
    await confirmProcessGroupsGone([pid], 2000);
    return;
  }
  await waitForDetachedProcessExit(pid);
}

async function waitForDetachedProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (true) {
    if (isPidProvablyGone(pid)) return;
    if (Date.now() >= deadline) throw new Error(`Detached test process tree ${pid} is still alive`);
    await Bun.sleep(10);
  }
}
