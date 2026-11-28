import {
  type AttentionQueueItem,
  type AttentionSnapshotResponse,
  parseSnapshotJson,
  validateAnswerChoice,
} from './queue-state';

export interface ProcessRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface AnswerCommandResult {
  ok: boolean;
  ref: string;
  choice: string;
  message: string;
  raw?: unknown;
}

export interface ArchonModApi {
  process: {
    run(argv: string[], init?: { cwd?: string; timeoutMs?: number }): Promise<ProcessRunResult>;
  };
}

export function buildSnapshotArgv(binary = 'archon'): string[] {
  return [binary, 'workflow', 'attention', '--all', '--json'];
}

export function buildWatchArgv(afterCursor?: string, binary = 'archon'): string[] {
  const argv = [binary, 'workflow', 'attention', '--all', '--watch', '--protocol', '--json'];
  if (afterCursor && afterCursor.trim().length > 0) {
    argv.push('--after', afterCursor.trim());
  }
  return argv;
}

export function buildAnswerArgv(
  item: AttentionQueueItem,
  choice: string,
  text?: string,
  binary = 'archon'
): string[] {
  const trimmedChoice = choice.trim();
  const trimmedText = (text ?? '').trim();

  if (item.run !== undefined) {
    const argv = [binary, 'workflow', 'respond', item.run.id, trimmedChoice];
    if (item.run.occurrence) {
      argv.push('--occurrence', item.run.occurrence);
    }
    if (trimmedText.length > 0) {
      argv.push('--text', trimmedText);
    }
    argv.push('--json');
    return argv;
  }

  const argv = [binary, 'workflow', 'answer', '--ref', item.ref, '--choose', trimmedChoice];
  if (trimmedText.length > 0) {
    argv.push('--text', trimmedText);
  }
  argv.push('--json');
  return argv;
}

export function parseAnswerResult(
  ref: string,
  choice: string,
  result: ProcessRunResult
): AnswerCommandResult {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (stdout.length > 0) {
    try {
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      if (parsed.ok === true) {
        return {
          ok: true,
          ref,
          choice,
          message: `Recorded '${choice}' for ${ref}.`,
          raw: parsed,
        };
      }
      const errText =
        typeof parsed.message === 'string'
          ? parsed.message
          : typeof parsed.error === 'string'
            ? parsed.error
            : `Command failed with exit code ${result.exitCode}`;
      return {
        ok: false,
        ref,
        choice,
        message: errText,
        raw: parsed,
      };
    } catch {
      // Fall through to plain text fallback
    }
  }

  if (result.exitCode === 0) {
    return { ok: true, ref, choice, message: `Recorded '${choice}' for ${ref}.` };
  }
  return {
    ok: false,
    ref,
    choice,
    message: stderr || stdout || `archon exited with code ${result.exitCode}`,
  };
}

export async function fetchAttentionSnapshot(
  $: ArchonModApi,
  binary = 'archon'
): Promise<AttentionSnapshotResponse> {
  try {
    const res = await $.process.run(buildSnapshotArgv(binary), { timeoutMs: 15_000 });
    if (res.exitCode !== 0 && res.stdout.trim().length === 0) {
      return {
        ok: false,
        error: res.stderr.trim() || `archon exited with code ${res.exitCode}`,
      };
    }
    return parseSnapshotJson(res.stdout);
  } catch (error) {
    return {
      ok: false,
      error: `Failed to run archon CLI: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function submitAttentionAnswer(
  $: ArchonModApi,
  item: AttentionQueueItem,
  choice: string,
  text?: string,
  binary = 'archon'
): Promise<AnswerCommandResult> {
  const validation = validateAnswerChoice(item, choice, text);
  if (!validation.ok) {
    return {
      ok: false,
      ref: item.ref,
      choice,
      message: validation.error ?? 'Invalid choice',
    };
  }
  try {
    const argv = buildAnswerArgv(item, choice, text, binary);
    const res = await $.process.run(argv, { timeoutMs: 25_000 });
    return parseAnswerResult(item.ref, choice, res);
  } catch (error) {
    return {
      ok: false,
      ref: item.ref,
      choice,
      message: `Failed to run archon CLI: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
