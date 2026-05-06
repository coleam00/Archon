/**
 * Real-execution proof validator (ROADMAP P3-A).
 *
 * Three layered checks, evaluated in order, returned as a single discriminated
 * union via `validateEvidence(...)`:
 *
 *   1. SHAPE     — Zod parse against `executionEvidenceSchema`. Pure, no I/O.
 *   2. INTEGRITY — Cross-field rules (planning rejected as execution; protected
 *                  branches rejected; zero-tree SHA rejected). Pure, no I/O.
 *   3. REALITY   — `git cat-file -e`, `git ls-remote --heads origin <branch>`,
 *                  and `gh pr view <url> --json headRefName,number` confirm
 *                  the claimed SHA, branch, and PR are real. Async I/O.
 *                  Only runs when `policy.verify === 'reality'`.
 *
 * The orchestrator stops at the first layer that produces errors, so callers
 * always see the most actionable diagnostic. No layer throws — every failure
 * mode produces structured `EvidenceValidationIssue[]`. Throwing would skip
 * the executor's evidence-failure → `failed` transition and surface as an
 * unrelated runtime error.
 */
import { readFile } from 'fs/promises';
import { isAbsolute, join } from 'path';
import { execFileAsync } from '@archon/git';
import { createLogger } from '@archon/paths';
import { executionEvidenceSchema } from './schemas';
import type {
  ExecutionEvidence,
  EvidencePolicy,
  EvidenceValidationIssue,
  EvidenceValidationResult,
} from './schemas';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.evidence-validator');
  return cachedLog;
}

/** Branches that workers must NOT push directly to — feature-branch heuristic. */
const PROTECTED_BRANCHES: readonly string[] = ['main', 'master', 'dev', 'develop'];

/** Empty-tree zero SHA — well-known git constant; never a real commit. */
const ZERO_SHA = '0000000000000000000000000000000000000000';

// ---------------------------------------------------------------------------
// SHAPE — Zod parse, no I/O
// ---------------------------------------------------------------------------

/**
 * Pure Zod parse. Converts each Zod issue into a per-field
 * `EvidenceValidationIssue`. Returns `{ valid: true, evidence }` on success.
 */
export function validateEvidenceShape(raw: unknown): EvidenceValidationResult {
  const result = executionEvidenceSchema.safeParse(raw);
  if (result.success) {
    return { valid: true, evidence: result.data };
  }
  const issues: EvidenceValidationIssue[] = result.error.issues.map(issue => ({
    level: 'error',
    field: issue.path.length > 0 ? issue.path.join('.') : 'evidence',
    message: issue.message,
  }));
  return { valid: false, issues };
}

// ---------------------------------------------------------------------------
// INTEGRITY — cross-field rules, no I/O
// ---------------------------------------------------------------------------

/**
 * Cross-field integrity checks. Returns `[]` if all pass. The schema already
 * enforces individual field shapes; this layer enforces relationships and
 * known-bad values that the schema cannot express directly.
 */
export function validateEvidenceIntegrity(evidence: ExecutionEvidence): EvidenceValidationIssue[] {
  const issues: EvidenceValidationIssue[] = [];

  if (evidence.kind === 'planning') {
    issues.push({
      level: 'error',
      field: 'kind',
      message:
        "Planning evidence (kind: 'planning') cannot satisfy real-execution proof. " +
        "Emit kind: 'execution' with the full set of execution fields.",
      hint: 'Did the workflow actually commit, push, and open a PR?',
    });
    return issues;
  }

  // From here `evidence.kind === 'execution'`; narrow the type.
  if (evidence.provider_run_ids.length === 0) {
    issues.push({
      level: 'error',
      field: 'provider_run_ids',
      message: 'provider_run_ids must contain at least one session id',
    });
  }

  if (PROTECTED_BRANCHES.includes(evidence.pushed_branch)) {
    issues.push({
      level: 'error',
      field: 'pushed_branch',
      message: `pushed_branch '${evidence.pushed_branch}' is a protected branch; workers must commit to a feature branch`,
      hint: `Disallowed: ${PROTECTED_BRANCHES.join(', ')}`,
    });
  }

  if (evidence.commit_sha === ZERO_SHA) {
    issues.push({
      level: 'error',
      field: 'commit_sha',
      message: 'commit_sha is the empty-tree zero SHA; this is never a real commit',
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// REALITY — async I/O against git and gh
// ---------------------------------------------------------------------------

/**
 * Confirms the claimed SHA is reachable in `cwd`, the branch is on origin,
 * and the PR URL maps to the same branch and pr_number. Reality checks are
 * best-effort: any non-zero exit or shape mismatch becomes a structured
 * `level: 'error'` issue. `gh` missing or unauthenticated produces a clean
 * issue with a setup hint — never throws.
 */
export async function verifyEvidenceReality(
  evidence: ExecutionEvidence,
  cwd: string
): Promise<EvidenceValidationIssue[]> {
  if (evidence.kind !== 'execution') {
    // Integrity layer already rejects planning; defensive guard so callers
    // that skip integrity (none currently) still see a clean issue.
    return [
      {
        level: 'error',
        field: 'kind',
        message: "verifyEvidenceReality requires kind: 'execution'",
      },
    ];
  }

  const issues: EvidenceValidationIssue[] = [];

  // 1. commit_sha reachable in worktree
  try {
    await execFileAsync('git', ['cat-file', '-e', `${evidence.commit_sha}^{commit}`], { cwd });
  } catch (err) {
    const e = err as Error & { stderr?: string };
    issues.push({
      level: 'error',
      field: 'commit_sha',
      message: `git cat-file -e ${evidence.commit_sha}^{commit} failed: ${
        e.stderr?.trim() || e.message
      }`,
      hint: 'commit_sha is not reachable in this checkout — fake SHA or wrong cwd',
    });
  }

  // 2. pushed_branch present on origin
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-remote', '--heads', 'origin', evidence.pushed_branch],
      { cwd }
    );
    if (stdout.trim().length === 0) {
      issues.push({
        level: 'error',
        field: 'pushed_branch',
        message: `git ls-remote --heads origin ${evidence.pushed_branch} returned empty; branch is not on origin`,
        hint: 'Did the workflow run `git push -u origin <branch>` after committing?',
      });
    }
  } catch (err) {
    const e = err as Error & { stderr?: string };
    issues.push({
      level: 'error',
      field: 'pushed_branch',
      message: `git ls-remote failed: ${e.stderr?.trim() || e.message}`,
    });
  }

  // 3. gh pr view confirms PR url maps to pushed_branch and pr_number
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'view', evidence.pr_url, '--json', 'headRefName,number'],
      { cwd }
    );
    let parsed: { headRefName?: unknown; number?: unknown } | undefined;
    try {
      parsed = JSON.parse(stdout) as { headRefName?: unknown; number?: unknown };
    } catch {
      issues.push({
        level: 'error',
        field: 'pr_url',
        message: `gh pr view returned non-JSON output for ${evidence.pr_url}`,
      });
      return issues;
    }
    if (parsed.headRefName !== evidence.pushed_branch) {
      issues.push({
        level: 'error',
        field: 'pr_url',
        message: `gh pr view headRefName='${String(parsed.headRefName)}' does not match pushed_branch='${evidence.pushed_branch}'`,
        hint: 'pr_url points to a PR for a different branch',
      });
    }
    if (parsed.number !== evidence.pr_number) {
      issues.push({
        level: 'error',
        field: 'pr_number',
        message: `gh pr view number=${String(parsed.number)} does not match pr_number=${evidence.pr_number}`,
      });
    }
  } catch (err) {
    const e = err as Error & { code?: string; stderr?: string };
    if (e.code === 'ENOENT') {
      issues.push({
        level: 'error',
        field: 'pr_url',
        message: 'gh binary not found on PATH',
        hint: "install gh and run 'gh auth status' (or set evidence_policy.verify: 'shape')",
      });
    } else {
      issues.push({
        level: 'error',
        field: 'pr_url',
        message: `gh pr view ${evidence.pr_url} failed: ${e.stderr?.trim() || e.message}`,
        hint: "run 'gh auth status' to confirm authentication",
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// LOAD — read evidence.json from artifacts dir
// ---------------------------------------------------------------------------

/**
 * Result of loading an evidence file. `raw` is the parsed JSON value when the
 * file exists and parses; on JSON parse failure we still return `found: true`
 * with `raw` as the original string so the shape validator can produce a
 * clean issue (and never a thrown exception).
 */
export type LoadEvidenceResult = { found: false } | { found: true; raw: unknown };

/**
 * Read the evidence file at `<artifactsDir>/<path>`. On `ENOENT` returns
 * `{ found: false }`; on JSON parse failure returns `{ found: true; raw:
 * <original string> }` so the caller can surface a structured issue instead
 * of a thrown error.
 */
export async function loadEvidenceFromArtifacts(
  artifactsDir: string,
  path = 'evidence.json'
): Promise<LoadEvidenceResult> {
  const fullPath = join(artifactsDir, path);
  let contents: string;
  try {
    contents = await readFile(fullPath, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { found: false };
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(contents);
    return { found: true, raw: parsed };
  } catch {
    return { found: true, raw: contents };
  }
}

// ---------------------------------------------------------------------------
// ORCHESTRATOR — public entry point
// ---------------------------------------------------------------------------

export interface ValidateEvidenceArgs {
  /** Resolved artifacts directory ($ARTIFACTS_DIR for the run). */
  artifactsDir: string;
  /** Working directory for git/gh reality checks (typically the run cwd). */
  cwd: string;
  /** Workflow-level evidence policy. */
  policy: EvidencePolicy;
}

/**
 * Run the full evidence-validation pipeline. Loads, then SHAPE, then
 * INTEGRITY, then (when `policy.verify === 'reality'`) REALITY. Stops at
 * the first layer that produces errors. Never throws.
 */
export async function validateEvidence(
  args: ValidateEvidenceArgs
): Promise<EvidenceValidationResult> {
  const { artifactsDir, cwd, policy } = args;
  getLog().info(
    { artifactsDir, path: policy.path, verify: policy.verify },
    'evidence_validation_started'
  );

  // Path-traversal defense: reject absolute paths and any '..' segment before
  // touching the filesystem.
  if (isAbsolute(policy.path)) {
    const issues: EvidenceValidationIssue[] = [
      {
        level: 'error',
        field: 'evidence_policy.path',
        message: `evidence_policy.path '${policy.path}' must be relative to $ARTIFACTS_DIR`,
      },
    ];
    getLog().error({ issues }, 'evidence_validation_failed');
    return { valid: false, issues };
  }
  if (policy.path.split(/[\\/]/).some(seg => seg === '..')) {
    const issues: EvidenceValidationIssue[] = [
      {
        level: 'error',
        field: 'evidence_policy.path',
        message: `evidence_policy.path '${policy.path}' must not contain '..' segments`,
      },
    ];
    getLog().error({ issues }, 'evidence_validation_failed');
    return { valid: false, issues };
  }

  // 0. LOAD
  let load: LoadEvidenceResult;
  try {
    load = await loadEvidenceFromArtifacts(artifactsDir, policy.path);
  } catch (err) {
    const e = err as Error;
    const issues: EvidenceValidationIssue[] = [
      {
        level: 'error',
        field: 'evidence_policy.path',
        message: `failed to read evidence file '${policy.path}': ${e.message}`,
      },
    ];
    getLog().error({ err, issues }, 'evidence_validation_failed');
    return { valid: false, issues };
  }
  if (!load.found) {
    const issues: EvidenceValidationIssue[] = [
      {
        level: 'error',
        field: 'evidence_policy.path',
        message: `evidence file not found at $ARTIFACTS_DIR/${policy.path}`,
        hint: 'PR-producing workflows must write evidence.json before completion',
      },
    ];
    getLog().error({ issues }, 'evidence_validation_failed');
    return { valid: false, issues };
  }

  // 1. SHAPE
  const shapeResult = validateEvidenceShape(load.raw);
  if (!shapeResult.valid) {
    getLog().error({ issues: shapeResult.issues }, 'evidence_validation_failed');
    return shapeResult;
  }

  // 2. INTEGRITY
  const integrityIssues = validateEvidenceIntegrity(shapeResult.evidence);
  if (integrityIssues.length > 0) {
    getLog().error({ issues: integrityIssues }, 'evidence_validation_failed');
    return { valid: false, issues: integrityIssues };
  }

  // 3. REALITY (opt-in)
  if (policy.verify === 'reality') {
    const realityIssues = await verifyEvidenceReality(shapeResult.evidence, cwd);
    if (realityIssues.length > 0) {
      getLog().error({ issues: realityIssues }, 'evidence_validation_failed');
      return { valid: false, issues: realityIssues };
    }
  }

  getLog().info({ kind: shapeResult.evidence.kind }, 'evidence_validation_completed');
  return shapeResult;
}
