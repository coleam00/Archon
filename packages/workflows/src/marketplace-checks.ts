/**
 * Marketplace submission gate checks (schema validation + security scan) as
 * pure, in-process functions over an in-memory file list.
 *
 * This is the SINGLE source of truth for both consumers, so there is no drift
 * risk between them (they call the literal same function, not just "the same
 * script file" — a stronger guarantee than shelling out):
 *   - `.archon/scripts/marketplace-validate-schema.ts` /
 *     `marketplace-security-scan.ts` — thin CLI wrappers that read
 *     `$ARTIFACTS_DIR/source/`, call these functions, and print the result as
 *     JSON (the contract the real marketplace CI / auto-review workflow
 *     depends on — see `.archon/workflows/maintainer/marketplace-pr-review-and-merge.yaml`).
 *   - `packages/server/src/services/marketplace-publish/preflight.ts` — calls
 *     these directly on the in-memory bundle, with no scratch directory, no
 *     `execFileAsync`, and no dependency on the server process's own git
 *     checkout being present on disk (which a compiled-binary install does
 *     not have — see ADR-0001's amendment).
 */
import { parseWorkflow } from './loader';

export interface MarketplaceFile {
  /** Relative display path (never parsed, only surfaced verbatim). */
  name: string;
  content: string;
}

export interface SchemaValidateFileResult {
  name: string;
  valid: boolean;
  errors: string[];
}

export interface SchemaValidateOutput {
  valid: boolean;
  files: SchemaValidateFileResult[];
  note?: string;
}

/**
 * Decide whether a YAML file is shaped like an Archon workflow definition
 * (top-level `nodes:` block). Marketplace directory submissions commonly
 * include non-workflow YAML like brand.yaml, config.yaml, or template
 * scaffolds — those should not be validated against the workflow schema.
 */
function looksLikeWorkflow(yamlContent: string): boolean {
  return /^nodes\s*:/m.test(yamlContent);
}

/**
 * Validate every workflow-shaped `.yaml`/`.yml` file in `files` against the
 * Archon workflow schema. Non-yaml files and yaml files without a top-level
 * `nodes:` block are silently skipped (not an error — see `looksLikeWorkflow`).
 * Always returns `valid: true` with an explanatory `note` for the degenerate
 * "nothing to validate" cases, mirroring the standalone CI script's contract.
 */
export function validateMarketplaceWorkflowFiles(files: MarketplaceFile[]): SchemaValidateOutput {
  const yamlFiles = files.filter(f => /\.ya?ml$/i.test(f.name));
  if (yamlFiles.length === 0) {
    return { valid: true, files: [], note: 'no yaml files found' };
  }

  const workflowFiles = yamlFiles.filter(f => looksLikeWorkflow(f.content));
  if (workflowFiles.length === 0) {
    return { valid: true, files: [], note: 'no workflow yaml files (no top-level nodes:)' };
  }

  const results: SchemaValidateFileResult[] = workflowFiles.map(f => {
    const result = parseWorkflow(f.content, f.name);
    return result.workflow === null
      ? { name: f.name, valid: false, errors: [result.error.error] }
      : { name: f.name, valid: true, errors: [] };
  });

  return { valid: results.every(r => r.valid), files: results };
}

export type SecurityCategory =
  | 'rce'
  | 'exfil'
  | 'reverse_shell'
  | 'cred_leak'
  | 'obfuscation'
  | 'unsafe_permissions'
  | 'path_escape'
  | 'shell_exec'
  | 'suspicious_network';
export type SecuritySeverity = 'none' | 'low' | 'medium' | 'high' | 'critical';

export interface SecurityFinding {
  file: string;
  line: number;
  category: SecurityCategory;
  pattern: string;
  context: string;
}

export interface SecurityScanOutput {
  severity: SecuritySeverity;
  finding_count: number;
  findings: SecurityFinding[];
}

const SECURITY_PATTERNS: Record<SecurityCategory, RegExp[]> = {
  rce: [/eval\s*\(/, /new\s+Function\s*\(/, /`\$\{.*\}`.*exec/],
  exfil: [
    /curl\s+[^|]+\|\s*(ba)?sh/,
    /wget\s+[^|]+\|\s*(ba)?sh/,
    /fetch\s*\([^)]+\).*\.\s*then.*exec/,
  ],
  reverse_shell: [/nc\s+.*-e\s+/, /bash\s+-i\s+>&\s*\/dev\/tcp\//, /mkfifo\s+.*\bsh\b/],
  cred_leak: [/echo.*GITHUB_TOKEN|curl.*GITHUB_TOKEN/, /process\.env\b.*\|\s*(curl|wget|fetch)/],
  obfuscation: [
    /atob\s*\(.*\b(eval|exec|spawn)\b/,
    /Buffer\.from\s*\([^,]+,\s*['"]base64['"]\).*exec/,
  ],
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

const SECURITY_SEVERITY_MAP: Record<SecurityCategory, SecuritySeverity> = {
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

const SECURITY_SEVERITY_ORDER: Record<SecuritySeverity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function computeSeverity(findings: SecurityFinding[]): SecuritySeverity {
  let max: SecuritySeverity = 'none';
  for (const f of findings) {
    const s = SECURITY_SEVERITY_MAP[f.category];
    if (SECURITY_SEVERITY_ORDER[s] > SECURITY_SEVERITY_ORDER[max]) max = s;
  }
  return max;
}

/**
 * Scan every file in `files` (regardless of extension — mirrors the CI
 * script's own "scan everything under source/" behavior) against the 9
 * pattern categories. Always returns a result (no throw); the caller decides
 * the pass/fail threshold.
 */
export function scanMarketplaceFilesForSecurityIssues(
  files: MarketplaceFile[]
): SecurityScanOutput {
  const findings: SecurityFinding[] = [];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (const [category, patterns] of Object.entries(SECURITY_PATTERNS) as [
      SecurityCategory,
      RegExp[],
    ][]) {
      for (const pattern of patterns) {
        lines.forEach((line, idx) => {
          if (pattern.test(line)) {
            findings.push({
              file: file.name,
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
  const severity = computeSeverity(findings);
  return { severity, finding_count: findings.length, findings };
}
