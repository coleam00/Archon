/**
 * A fake `archon` CLI for the review bench's own process.
 *
 * The bench reaches the CLI through `Bun.spawn(['archon', ...])`. `install` answers
 * those calls inside the bench process, loaded through a generated `--preload`, so no
 * stub executable has to be found on `PATH`: Windows runs neither a shebang script nor,
 * with an argument holding a newline, a `.cmd` shim.
 *
 * Its state is a directory, because one test runs the bench more than once: `count`
 * numbers launches across processes, each launch's arguments land in `argv-<n>.json`,
 * `wait.json` is every `workflow wait` answer, and `detail.json`, when present, is every
 * `workflow get` answer; without it `get` returns only the run's id and status.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function answer(dir: string, args: readonly string[]): string {
  switch (args[1]) {
    case 'run': {
      const count = join(dir, 'count');
      const n = (existsSync(count) ? Number(readFileSync(count, 'utf8')) : 0) + 1;
      writeFileSync(count, String(n));
      writeFileSync(join(dir, `argv-${n}.json`), JSON.stringify(args));
      return JSON.stringify({ runId: `run-${n}` });
    }
    case 'wait':
      return readFileSync(join(dir, 'wait.json'), 'utf8');
    case 'get': {
      const detail = join(dir, 'detail.json');
      return existsSync(detail) ? readFileSync(detail, 'utf8') : JSON.stringify({ id: args[2], status: 'completed' });
    }
    default:
      throw new Error(`fake archon: unexpected command ${args.join(' ')}`);
  }
}

export function install(dir: string): void {
  const spawn = Bun.spawn;
  const fake = (cmd: string[], options?: Parameters<typeof spawn>[1]) => {
    if (cmd[0] !== 'archon') return spawn(cmd, options);
    return {
      stdout: new Response(answer(dir, cmd.slice(1))).body,
      stderr: new Response('').body,
      exited: Promise.resolve(0),
    };
  };
  Object.assign(Bun, { spawn: fake });
}
