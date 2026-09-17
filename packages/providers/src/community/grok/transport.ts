import { spawn } from 'node:child_process';

export const GROK_TERM_GRACE_MS = 10_000;
export const GROK_KILL_GRACE_MS = 2_000;

export interface GrokCommandResult {
  exitCode: number;
  stderr: string;
  nativeClosed: boolean;
}

export type GrokCommandRunner = (input: {
  argv: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onLine: (line: string) => void;
  termGraceMs?: number;
  killGraceMs?: number;
}) => Promise<GrokCommandResult>;

export function runGrokCommand(input: {
  argv: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onLine: (line: string) => void;
  termGraceMs?: number;
  killGraceMs?: number;
}): Promise<GrokCommandResult> {
  const [command, ...args] = input.argv;
  if (!command) throw new Error('grok_binary_missing');
  const termGraceMs = input.termGraceMs ?? GROK_TERM_GRACE_MS;
  const killGraceMs = input.killGraceMs ?? GROK_KILL_GRACE_MS;
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr: Buffer[] = [];
    let remainder = '';
    let settled = false;
    let nativeClosed = false;
    let escalating = false;
    let termTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      if (remainder.length > 0) {
        const leftover = remainder;
        remainder = '';
        input.onLine(leftover);
      }
      resolve({
        exitCode,
        stderr: Buffer.concat(stderr).toString('utf8'),
        nativeClosed,
      });
    };
    const escalate = (): void => {
      if (settled || escalating) return;
      if (child.pid === undefined) {
        nativeClosed = true;
        finish(1);
        return;
      }
      escalating = true;
      child.kill('SIGTERM');
      termTimer = setTimeout(() => {
        if (settled) return;
        child.kill('SIGKILL');
        killTimer = setTimeout(() => {
          finish(1);
        }, killGraceMs);
      }, termGraceMs);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      remainder += chunk.toString('utf8');
      let newline = remainder.indexOf('\n');
      while (newline >= 0) {
        input.onLine(remainder.slice(0, newline));
        remainder = remainder.slice(newline + 1);
        newline = remainder.indexOf('\n');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on('error', error => {
      stderr.push(Buffer.from(error instanceof Error ? error.message : String(error)));
      if (child.pid === undefined) {
        nativeClosed = true;
        finish(1);
        return;
      }
      escalate();
    });
    child.on('close', code => {
      nativeClosed = true;
      finish(code ?? 1);
    });
    if (input.signal?.aborted) escalate();
    else input.signal?.addEventListener('abort', escalate, { once: true });
  });
}
