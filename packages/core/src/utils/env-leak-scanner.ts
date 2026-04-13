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

/**
 * Context in which the env-leak error is being surfaced. Drives the remediation
 * copy so users see guidance that matches how they hit the gate.
 *
 * - `register-ui`: Add-Project flow in the Web UI (checkbox is visible)
 * - `register-cli`: CLI auto-register path (no Web UI)
 * - `spawn-existing`: Pre-spawn check for an already-registered codebase
 */
export type LeakErrorContext = 'register-ui' | 'register-cli' | 'spawn-existing';

export class EnvLeakError extends Error {
  public readonly context: LeakErrorContext;
  constructor(
    public readonly report: LeakReport,
    context: LeakErrorContext = 'register-ui'
  ) {
    super(formatLeakError(report, context));
    this.name = 'EnvLeakError';
    this.context = context;
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

/**
 * Exhaustive per-context consent remediation copy. Using `switch` with a
 * `never` default means adding a new `LeakErrorContext` variant without
 * handling it here is a compile error — important for a security-visible path.
 */
function consentCopy(context: LeakErrorContext): string {
  switch (context) {
    case 'register-cli':
      return `    3. Acknowledge the risk and allow this codebase to use its .env key:
       Re-run the CLI command with --allow-env-keys, or set
       'allow_target_repo_keys: true' in ~/.archon/config.yaml to bypass this
       gate globally.`;
    case 'spawn-existing':
      return `    3. Acknowledge the risk for this already-registered codebase:
       Open the Web UI (Settings → Projects), find this project, and toggle
       "Allow env keys". Or set 'allow_target_repo_keys: true' in
       ~/.archon/config.yaml to bypass this gate globally.`;
    case 'register-ui':
      return `    3. Acknowledge the risk and allow this codebase to use its .env key:
       Open the web UI (Settings → Projects → Add Project) and tick
       "Allow env keys (I understand the risk)" when adding this project.`;
    default: {
      const exhaustive: never = context;
      return exhaustive;
    }
  }
}

function escapeRegexForGrep(raw: string): string {
  return raw.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function collectOffendingKeys(report: LeakReport): string[] {
  const ordered = report.findings.flatMap(f => f.keys).filter(key => !key.startsWith('['));
  return [...new Set(ordered)];
}

function buildRemediationCommand(report: LeakReport): string {
  const offendingKeys = collectOffendingKeys(report);
  const keyPattern =
    offendingKeys.length > 0
      ? offendingKeys.map(escapeRegexForGrep).join('|')
      : 'ANTHROPIC_API_KEY';

  return `grep -vE '^(${keyPattern})=' .env > .env.tmp && mv .env.tmp .env`;
}

export function formatLeakError(
  report: LeakReport,
  context: LeakErrorContext = 'register-ui'
): string {
  const fileList = report.findings.map(f => `    ${f.file} — ${f.keys.join(', ')}`).join('\n');
  const offendingKeys = collectOffendingKeys(report);
  const keyWord = offendingKeys.length > 1 ? 'keys' : 'key';
  const remediationCommand = buildRemediationCommand(report);

  const header =
    context === 'spawn-existing'
      ? `Cannot run workflow — ${report.path} contains keys that will leak into AI subprocesses`
      : `Cannot add codebase — ${report.path} contains keys that will leak into AI subprocesses`;

  const consent = consentCopy(context);

  return `${header}

  Found:
${fileList}

  Why this matters:
  Bun subprocesses auto-load .env from their working directory. Archon cleans
  its own environment, but Claude/Codex subprocesses running with cwd=<this repo>
  will re-inject these keys at their own startup, bypassing archon's allowlist.
  This can bill the wrong API account silently.

  Choose one:
    1. Remove the ${keyWord} from this repo's .env (recommended):
         ${remediationCommand}

    2. Rename to a non-auto-loaded file:
         mv .env .env.secrets
         # update your app to load it explicitly

${consent}`;
}
