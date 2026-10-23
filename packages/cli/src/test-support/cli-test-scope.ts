import { removeTempTree } from '@archon/paths/test-utils';

export class CliTestScope {
  private closed = false;
  private readonly children = new Map<Bun.Subprocess<'pipe', 'pipe', 'pipe'>, Promise<unknown>>();

  constructor(readonly root: string) {}

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
    await removeTempTree(this.root);
  }
}
