#!/usr/bin/env bun
/**
 * Deterministic security scanner for marketplace submission source files.
 * Reads all files from $ARTIFACTS_DIR/source/ recursively and checks against
 * 9 pattern categories. Exits 0 regardless of findings (caller decides threshold).
 * Output: JSON to stdout with severity + findings array.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

type Category =
  | 'rce'
  | 'exfil'
  | 'reverse_shell'
  | 'cred_leak'
  | 'obfuscation'
  | 'unsafe_permissions'
  | 'path_escape'
  | 'shell_exec'
  | 'suspicious_network';
type Severity = 'none' | 'low' | 'medium' | 'high' | 'critical';

interface Finding {
  file: string;
  line: number;
  category: Category;
  pattern: string;
  context: string;
}

interface ScanResult {
  severity: Severity;
  finding_count: number;
  findings: Finding[];
}

const PATTERNS: Record<Category, RegExp[]> = {
  rce: [/eval\s*\(/, /new\s+Function\s*\(/, /`\$\{.*\}`.*exec/],
  exfil: [/curl\s+[^|]+\|\s*(ba)?sh/, /wget\s+[^|]+\|\s*(ba)?sh/, /fetch\s*\([^)]+\).*\.\s*then.*exec/],
  reverse_shell: [/nc\s+.*-e\s+/, /bash\s+-i\s+>&\s*\/dev\/tcp\//, /mkfifo\s+.*\bsh\b/],
  cred_leak: [/echo.*GITHUB_TOKEN|curl.*GITHUB_TOKEN/, /process\.env\b.*\|\s*(curl|wget|fetch)/],
  obfuscation: [/atob\s*\(.*\b(eval|exec|spawn)\b/, /Buffer\.from\s*\([^,]+,\s*['"]base64['"]\).*exec/],
  unsafe_permissions: [
    /--dangerously-skip-permissions/,
    /sudo\s+/,
    /allowed_tools:.*\bBash\b/,
    /denied_tools:\s*\[\s*\]/,
  ],
  path_escape: [/\.\.\/\.\.\//, /readFileSync\s*\(\s*['"][/~]/],
  shell_exec: [
    /exec\s*\(.*shell\s*:\s*true/,
    /child_process\.exec\s*\(/,
    /require\s*\(\s*['"]shelljs['"]\)|from\s+['"]shelljs['"]/,
  ],
  suspicious_network: [
    /https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
    /(curl|wget|fetch)\s*\(?['"]https?:\/\/(?!github\.com|archon\.diy)/,
  ],
};

const SEVERITY_MAP: Record<Category, Severity> = {
  rce: 'critical',
  exfil: 'critical',
  reverse_shell: 'critical',
  cred_leak: 'high',
  obfuscation: 'high',
  unsafe_permissions: 'high',
  path_escape: 'medium',
  shell_exec: 'medium',
  suspicious_network: 'medium',
};

const SEVERITY_ORDER: Record<Severity, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

function computeSeverity(findings: Finding[]): Severity {
  let max: Severity = 'none';
  for (const f of findings) {
    const s = SEVERITY_MAP[f.category];
    if (SEVERITY_ORDER[s] > SEVERITY_ORDER[max]) max = s;
  }
  return max;
}

function findAllFiles(dir: string, base: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...findAllFiles(full, base));
    } else {
      found.push(relative(base, full));
    }
  }
  return found;
}

const artifactsDir = process.env['ARTIFACTS_DIR'] ?? '';
if (!artifactsDir) {
  process.stderr.write('ARTIFACTS_DIR env var is required\n');
  process.exit(1);
}

const sourceDir = resolve(artifactsDir, 'source');
const findings: Finding[] = [];

if (existsSync(sourceDir)) {
  for (const relativePath of findAllFiles(sourceDir, sourceDir)) {
    const content = readFileSync(resolve(sourceDir, relativePath), 'utf8');
    const lines = content.split('\n');
    for (const [category, patterns] of Object.entries(PATTERNS) as [Category, RegExp[]][]) {
      for (const pattern of patterns) {
        lines.forEach((line, idx) => {
          if (pattern.test(line)) {
            findings.push({
              file: relativePath,
              line: idx + 1,
              category,
              pattern: pattern.source,
              context: line.trim(),
            });
          }
        });
      }
    }
  }
}

const severity = computeSeverity(findings);
const result: ScanResult = { severity, finding_count: findings.length, findings };
console.log(JSON.stringify(result, null, 2));
