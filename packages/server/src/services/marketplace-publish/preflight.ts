/**
 * Pre-flight gates mirroring marketplace CI: runs the same two checks CI runs
 * — schema validation and a security scan — over the bundle's in-memory
 * files, so a submission that passes here can never bounce on those CI
 * gates.
 *
 * Runs the checks IN-PROCESS via `@archon/workflows/marketplace-checks`, the
 * same pure functions `.archon/scripts/marketplace-validate-schema.ts` and
 * `marketplace-security-scan.ts` call as thin CLI wrappers — a single shared
 * source of truth, so there is no drift between what real CI enforces and
 * what a Submit blocks on. This also means pre-flight has no dependency on
 * the Archon server process's own git checkout being present on disk (a
 * compiled-binary install has no source tree — see ADR-0001's amendment);
 * the earlier shell-out design required `.archon/scripts/*.ts` to exist
 * relative to the server's own repo root and failed cleanly for such
 * installs, tracked as a residual follow-up until this change.
 */
import {
  validateMarketplaceWorkflowFiles,
  scanMarketplaceFilesForSecurityIssues,
  type SchemaValidateOutput,
  type SecurityScanOutput,
} from '@archon/workflows/marketplace-checks';
import type { BundleFile } from './bundle';

export type { SchemaValidateOutput, SecurityScanOutput };

export interface GateResult {
  name: 'schema-validate' | 'security-scan';
  passed: boolean;
  detail: SchemaValidateOutput | SecurityScanOutput;
}

export interface PreflightResult {
  passed: boolean;
  gates: GateResult[];
}

/** `.archon/marketplace/<slug>/<rest>` -> `<rest>` (what the checks scan as `source/<rest>`). */
function stripBundlePrefix(repoPath: string): string {
  return repoPath.split('/').slice(3).join('/');
}

/**
 * Run both pre-flight gates over the bundle. Block thresholds (mirrors the
 * registry auto-review's `decide` precedence): schema blocks when
 * `valid === false`; security blocks when severity is anything but `none`
 * (medium already draws request-changes from the auto-review, so a clean
 * pre-flight submission cannot risk it).
 */
export function runPreflightGates(bundle: BundleFile[]): PreflightResult {
  const files = bundle.map(file => ({
    name: stripBundlePrefix(file.repoPath),
    content: file.content,
  }));

  const schemaOutput = validateMarketplaceWorkflowFiles(files);
  const securityOutput = scanMarketplaceFilesForSecurityIssues(files);

  const gates: GateResult[] = [
    { name: 'schema-validate', passed: schemaOutput.valid, detail: schemaOutput },
    { name: 'security-scan', passed: securityOutput.severity === 'none', detail: securityOutput },
  ];

  return { passed: gates.every(g => g.passed), gates };
}
