import type { GrokEffort } from './config';

const NATIVE_GROK_SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Flags we never pass. `--yolo` / `--always-approve` are aliases of
 * `--permission-mode bypassPermissions`; we use the named mode (same as
 * Claude's `permissionMode: 'bypassPermissions'`) and keep the aliases out
 * of argv. `--worktree` would check the session out of the DAG cwd.
 */
const FORBIDDEN_FLAG_RE = /--worktree|--yolo|--always-approve/u;

export function requireNativeGrokSessionUuid(sessionId: string): string {
  if (!NATIVE_GROK_SESSION_UUID.test(sessionId)) {
    throw new Error(
      `Grok resume requires a native session UUID, got ${JSON.stringify(sessionId)}.`
    );
  }
  return sessionId;
}

export function buildGrokArgv(input: {
  command: string;
  prompt: string;
  cwd: string;
  model: string;
  effort?: GrokEffort;
  resumeSessionId?: string;
  jsonSchema?: Record<string, unknown>;
  /** Extra rules appended to Grok's system prompt (`--rules`). */
  systemPrompt?: string;
}): string[] {
  const flags = [
    input.command,
    '--no-auto-update',
    '--oauth',
    '--no-leader',
    '--permission-mode',
    'bypassPermissions',
    '--cwd',
    input.cwd,
    '--model',
    input.model,
  ];
  if (input.effort) {
    flags.push('--reasoning-effort', input.effort);
  }
  if (input.resumeSessionId) {
    flags.push('--resume', requireNativeGrokSessionUuid(input.resumeSessionId));
  }
  if (input.systemPrompt) {
    flags.push('--rules', input.systemPrompt);
  }
  if (input.jsonSchema) {
    flags.push('--json-schema', JSON.stringify(input.jsonSchema));
  }
  // `--json-schema` implies `--output-format json`. Re-assert the NDJSON
  // stream Archon consumes after that flag so last-wins keeps streaming-json.
  flags.push('--output-format', 'streaming-json');
  flags.push('--prompt-json', JSON.stringify([{ type: 'text', text: input.prompt }]));
  // Only scan flag tokens. The prompt payload may mention --yolo as text.
  if (flags.filter(value => value.startsWith('--')).some(value => FORBIDDEN_FLAG_RE.test(value))) {
    throw new Error('grok_argv_forbidden');
  }
  return flags;
}
