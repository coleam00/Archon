import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export const SENSITIVE_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'GEMINI_API_KEY',
]);

export const AUTOLOADED_FILES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.development.local',
  '.env.production.local',
];

export interface LeakFinding {
  file: string;
  keys: string[];
}

export interface LeakReport {
  path: string;
  findings: LeakFinding[];
}

export class EnvLeakError extends Error {
  constructor(public readonly report: LeakReport) {
    super(formatLeakError(report));
    this.name = 'EnvLeakError';
  }
}

/**
 * Scan `dirPath` for auto-loaded .env files containing sensitive keys.
 * Pure function — no side effects.
 */
export function scanPathForSensitiveKeys(dirPath: string): LeakReport {
  const findings: LeakFinding[] = [];

  for (const filename of AUTOLOADED_FILES) {
    const fullPath = join(dirPath, filename);
    if (!existsSync(fullPath)) continue;

    let contents: string;
    try {
      contents = readFileSync(fullPath, 'utf8');
    } catch (err) {
      // File exists but is unreadable — treat as a finding to avoid silently bypassing the gate
      const code = (err as NodeJS.ErrnoException).code;
      findings.push({ file: filename, keys: [`[unreadable — ${code ?? 'unknown error'}]`] });
      continue;
    }

    const foundKeys: string[] = [];
    for (const line of contents.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const key = trimmed.split('=')[0].trim();
      if (SENSITIVE_KEYS.has(key)) {
        foundKeys.push(key);
      }
    }

    if (foundKeys.length > 0) {
      findings.push({ file: filename, keys: foundKeys });
    }
  }

  return { path: dirPath, findings };
}

export function formatLeakError(report: LeakReport): string {
  const fileList = report.findings.map(f => `    ${f.file} — ${f.keys.join(', ')}`).join('\n');

  return `Cannot use codebase — ${report.path} contains keys that will leak into AI subprocesses

  Found:
${fileList}

  Why this matters:
  Bun subprocesses auto-load .env from their working directory. Archon cleans
  its own environment, but Claude/Codex subprocesses running with cwd=<this repo>
  will re-inject these keys at their own startup, bypassing Archon's allowlist.
  This can bill the wrong API account silently.

  Fix (choose one):
    1. Remove the key from this repo's .env (recommended):
         grep -v '^ANTHROPIC_API_KEY=' .env > .env.tmp && mv .env.tmp .env

    2. Rename to a non-auto-loaded file:
         mv .env .env.secrets
         # update your app to load it explicitly`;
}
