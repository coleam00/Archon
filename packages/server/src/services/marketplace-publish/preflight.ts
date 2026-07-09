/**
 * Pre-flight gates mirroring marketplace CI (S1, run-confirmed): shells the
 * same two scripts CI runs — `marketplace-validate-schema.ts` and
 * `marketplace-security-scan.ts` — against a scratch `ARTIFACTS_DIR/source/`
 * scaffolded from the bundle file map, so a submission that passes here can
 * never bounce on those CI gates.
 *
 * Script paths resolve from ARCHON'S OWN repo root (the server process's own
 * checkout), not the user's project repo — these are Archon's bundled CI
 * scripts, always found at `.archon/scripts/marketplace-*.ts` regardless of
 * which project the submission originates from.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileAsync, findRepoRoot } from '@archon/git';
import type { BundleFile } from './bundle';

const SCHEMA_SCRIPT_RELPATH = ['.archon', 'scripts', 'marketplace-validate-schema.ts'];
const SECURITY_SCRIPT_RELPATH = ['.archon', 'scripts', 'marketplace-security-scan.ts'];

export interface SchemaValidateOutput {
  valid: boolean;
  files: { name: string; valid: boolean; errors: string[] }[];
  note?: string;
}

export interface SecurityScanOutput {
  severity: 'none' | 'low' | 'medium' | 'high' | 'critical';
  finding_count: number;
  findings: unknown[];
}

export interface GateResult {
  name: 'schema-validate' | 'security-scan';
  passed: boolean;
  detail: SchemaValidateOutput | SecurityScanOutput;
}

export interface PreflightResult {
  passed: boolean;
  gates: GateResult[];
}

export interface PreflightDeps {
  execFileAsync: typeof execFileAsync;
  findRepoRoot: typeof findRepoRoot;
}

const defaultDeps: PreflightDeps = { execFileAsync, findRepoRoot };

/** `.archon/marketplace/<slug>/<rest>` -> `<rest>` (what the scripts scan as `source/<rest>`). */
function stripBundlePrefix(repoPath: string): string {
  return repoPath.split('/').slice(3).join('/');
}

async function runGate<T>(
  name: 'schema-validate' | 'security-scan',
  scriptPath: string,
  scratchDir: string,
  exec: typeof execFileAsync
): Promise<T> {
  const { stdout } = await exec('bun', [scriptPath], {
    env: { ...process.env, ARTIFACTS_DIR: scratchDir },
  });
  try {
    // Parse the WHOLE stdout — security-scan pretty-prints multi-line JSON (S1).
    return JSON.parse(stdout) as T;
  } catch (err) {
    throw new Error(`Preflight gate "${name}" produced non-JSON stdout: ${(err as Error).message}`);
  }
}

/**
 * Scaffold a scratch `ARTIFACTS_DIR/source/` from the bundle, shell both gate
 * scripts, and map their output to pass/fail. Block thresholds (S1, mirrors
 * the registry auto-review's `decide` precedence): schema blocks when
 * `valid === false`; security blocks when severity is anything but `none`
 * (medium already draws request-changes from the auto-review, so a clean
 * pre-flight submission cannot risk it). Always cleans up the scratch dir.
 */
export async function runPreflightGates(
  bundle: BundleFile[],
  serverCwd: string,
  deps: PreflightDeps = defaultDeps
): Promise<PreflightResult> {
  const repoRoot = await deps.findRepoRoot(serverCwd);
  if (!repoRoot) {
    throw new Error(
      'Preflight gates require the Archon server process to be running from within a git repository.'
    );
  }

  const scratchDir = await mkdtemp(join(tmpdir(), 'archon-marketplace-preflight-'));
  try {
    const sourceDir = join(scratchDir, 'source');
    for (const file of bundle) {
      const relative = stripBundlePrefix(file.repoPath);
      const dest = join(sourceDir, relative);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, file.content, 'utf-8');
    }

    const schemaScriptPath = join(repoRoot, ...SCHEMA_SCRIPT_RELPATH);
    const securityScriptPath = join(repoRoot, ...SECURITY_SCRIPT_RELPATH);

    const [schemaOutput, securityOutput] = await Promise.all([
      runGate<SchemaValidateOutput>(
        'schema-validate',
        schemaScriptPath,
        scratchDir,
        deps.execFileAsync
      ),
      runGate<SecurityScanOutput>(
        'security-scan',
        securityScriptPath,
        scratchDir,
        deps.execFileAsync
      ),
    ]);

    const gates: GateResult[] = [
      { name: 'schema-validate', passed: schemaOutput.valid, detail: schemaOutput },
      { name: 'security-scan', passed: securityOutput.severity === 'none', detail: securityOutput },
    ];

    return { passed: gates.every(g => g.passed), gates };
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}
