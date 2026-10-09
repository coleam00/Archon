/** One git call, captured: a node's stderr reaches the operator, so only this pack's messages may. */
export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function git(...args: string[]): GitResult {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

/** A git call whose failure is a broken assumption: its stdout, or a throw naming the command. */
export function gitOrThrow(...args: string[]): string {
  const result = git(...args);
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}
