import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { createLogger } from '@archon/paths';
import type { ExecutionContext } from '../types';
import { buildDockerExecTranscriptReadArgs } from './container-spawn';
import type { BaselineModelUsage, SpendBaseline } from './session-spend';

const costStateSchema = z.object({
  type: z.literal('cost-state'),
  sessionId: z.uuid(),
  totalCostUSD: z.number().nonnegative(),
  modelUsage: z.record(
    z.string(),
    z.object({
      outputTokens: z.number().int().nonnegative(),
      inputTokens: z.number().int().nonnegative().optional(),
      cacheReadInputTokens: z.number().int().nonnegative().optional(),
      cacheCreationInputTokens: z.number().int().nonnegative().optional(),
    }) satisfies z.ZodType<BaselineModelUsage>
  ),
  hasUnknownModelCost: z.literal(false).optional(),
});
const recordSchema = z.object({ type: z.string() }).passthrough();

/** The last cost record is authoritative; a damaged tail must not revive an older baseline. */
export function parseSessionSpend(transcript: string, sessionId: string): SpendBaseline {
  let last: unknown;
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return { kind: 'unknown' };
    }
    const parsed = recordSchema.safeParse(record);
    if (!parsed.success) return { kind: 'unknown' };
    if (parsed.data.type === 'cost-state') last = record;
  }
  const result = costStateSchema.safeParse(last);
  if (!result.success || result.data.sessionId !== sessionId) return { kind: 'unknown' };
  return {
    kind: 'known',
    spend: { costUsd: result.data.totalCostUSD, modelUsage: result.data.modelUsage },
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Mirrors SDK getSessionInfo's no-dir lookup, including custom/long project slugs. */
async function findHostTranscripts(
  sessionId: string,
  input: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<string[]> {
  const home = (process.platform === 'win32' ? input.env.USERPROFILE : input.env.HOME) || homedir();
  const root = resolve(
    input.cwd,
    (input.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude')).normalize('NFC')
  );
  const projects = join(root, 'projects');
  const matches: string[] = [];
  for (const entry of await readdir(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(projects, entry.name, sessionId + '.jsonl');
    try {
      await stat(path);
      matches.push(path);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return matches;
}

/**
 * Whether the host has no transcript for `sessionId`: `true` when the lookup completed and
 * found none, `false` when one exists, `undefined` when it could not be established. Host
 * only; a container run's transcript is not checked.
 */
export async function claudeSessionTranscriptMissing(
  sessionId: string,
  input: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }
): Promise<boolean | undefined> {
  if (!z.uuid().safeParse(sessionId).success) return undefined;
  try {
    return (await findHostTranscripts(sessionId, input)).length === 0;
  } catch (error) {
    input.signal?.throwIfAborted();
    if (isNotFound(error)) return true;
    createLogger('provider.claude').warn(
      { code: error instanceof Error && 'code' in error ? error.code : undefined },
      'claude.session_lookup_failed'
    );
    return undefined;
  }
}

export async function readSessionSpendBaseline(
  sessionId: string | undefined,
  input: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    execContext?: ExecutionContext;
    signal?: AbortSignal;
  }
): Promise<SpendBaseline> {
  if (sessionId === undefined) return { kind: 'fresh' };
  input.signal?.throwIfAborted();
  if (!z.uuid().safeParse(sessionId).success) return { kind: 'unknown' };
  try {
    let transcript: string;
    if (input.execContext?.kind === 'container') {
      const args = buildDockerExecTranscriptReadArgs(
        input.execContext,
        input.cwd,
        input.env,
        sessionId
      );
      transcript = await new Promise<string>((resolve, reject) => {
        execFile(
          'docker',
          args,
          {
            timeout: 60_000,
            // Match the host readFile path: long transcripts routinely exceed a fixed cap.
            maxBuffer: Infinity,
            signal: input.signal,
          },
          (error, stdout) => (error ? reject(error) : resolve(stdout))
        );
      });
    } else {
      const paths = await findHostTranscripts(sessionId, input);
      const [path] = paths;
      if (paths.length !== 1 || path === undefined) return { kind: 'unknown' };
      transcript = await readFile(path, { encoding: 'utf8', signal: input.signal });
    }
    input.signal?.throwIfAborted();
    return parseSessionSpend(transcript, sessionId);
  } catch (error) {
    input.signal?.throwIfAborted();
    // execFile errors include credential-bearing docker argv; log only a machine code.
    createLogger('provider.claude').warn(
      {
        code: error instanceof Error && 'code' in error ? error.code : undefined,
      },
      'claude.session_spend_read_failed'
    );
    return { kind: 'unknown' };
  }
}
