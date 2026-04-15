/**
 * Bundled default commands and workflows for binary distribution
 *
 * These static imports are resolved at compile time and embedded into the binary.
 * When running as a standalone binary (without Bun), these provide the default
 * commands and workflows without needing filesystem access to the source repo.
 *
 * Import syntax uses `with { type: 'text' }` to import file contents as strings.
 */

import { BUNDLED_IS_BINARY } from '@archon/paths';

// =============================================================================
// Default Commands (24 total)
// =============================================================================

import archonAssistCmd from '../../../../.archon/commands/defaults/archon-assist.md' with { type: 'text' };
import archonAssistCodexCmd from '../../../../.archon/commands/defaults/archon-assist-codex.md' with { type: 'text' };
import archonCodeReviewAgentCmd from '../../../../.archon/commands/defaults/archon-code-review-agent.md' with { type: 'text' };
import archonCommentQualityAgentCmd from '../../../../.archon/commands/defaults/archon-comment-quality-agent.md' with { type: 'text' };
import archonComposeFinalizePrCmd from '../../../../.archon/commands/defaults/archon-compose-finalize-pr.md' with { type: 'text' };
import archonComposePrCmd from '../../../../.archon/commands/defaults/archon-compose-pr.md' with { type: 'text' };
import archonCreatePrCmd from '../../../../.archon/commands/defaults/archon-create-pr.md' with { type: 'text' };
import archonDocsImpactAgentCmd from '../../../../.archon/commands/defaults/archon-docs-impact-agent.md' with { type: 'text' };
import archonErrorHandlingAgentCmd from '../../../../.archon/commands/defaults/archon-error-handling-agent.md' with { type: 'text' };
import archonImplementIssueCmd from '../../../../.archon/commands/defaults/archon-implement-issue.md' with { type: 'text' };
import archonImplementReviewFixesCmd from '../../../../.archon/commands/defaults/archon-implement-review-fixes.md' with { type: 'text' };
import archonImplementCmd from '../../../../.archon/commands/defaults/archon-implement.md' with { type: 'text' };
import archonInvestigateIssueCmd from '../../../../.archon/commands/defaults/archon-investigate-issue.md' with { type: 'text' };
import archonPrReviewScopeCmd from '../../../../.archon/commands/defaults/archon-pr-review-scope.md' with { type: 'text' };
import archonRalphPrdCmd from '../../../../.archon/commands/defaults/archon-ralph-prd.md' with { type: 'text' };
import archonResolveMergeConflictsCmd from '../../../../.archon/commands/defaults/archon-resolve-merge-conflicts.md' with { type: 'text' };
import archonSyncPrWithMainCmd from '../../../../.archon/commands/defaults/archon-sync-pr-with-main.md' with { type: 'text' };
import archonSynthesizeReviewCmd from '../../../../.archon/commands/defaults/archon-synthesize-review.md' with { type: 'text' };
import archonTestCoverageAgentCmd from '../../../../.archon/commands/defaults/archon-test-coverage-agent.md' with { type: 'text' };
import archonValidatePrCodeReviewFeatureCmd from '../../../../.archon/commands/defaults/archon-validate-pr-code-review-feature.md' with { type: 'text' };
import archonValidatePrCodeReviewMainCmd from '../../../../.archon/commands/defaults/archon-validate-pr-code-review-main.md' with { type: 'text' };
import archonValidatePrE2eFeatureCmd from '../../../../.archon/commands/defaults/archon-validate-pr-e2e-feature.md' with { type: 'text' };
import archonValidatePrE2eMainCmd from '../../../../.archon/commands/defaults/archon-validate-pr-e2e-main.md' with { type: 'text' };
import archonValidatePrReportCmd from '../../../../.archon/commands/defaults/archon-validate-pr-report.md' with { type: 'text' };

// =============================================================================
// Default Scripts
// =============================================================================

// @ts-expect-error Bun text import of a TypeScript source asset is valid at runtime,
// but TypeScript rejects the .ts extension in import-attribute mode.
import detectProjectScript from '../../../../.archon/scripts/detect-project.ts' with { type: 'text' };
// @ts-expect-error Bun text import of a TypeScript source asset is valid at runtime,
// but TypeScript rejects the .ts extension in import-attribute mode.
import githubPrScript from '../../../../.archon/scripts/github-pr.ts' with { type: 'text' };

// =============================================================================
// Default Workflows (15 total)
// =============================================================================

import archonAssistWf from '../../../../.archon/workflows/defaults/archon-assist.yaml' with { type: 'text' };
import archonAssistCodexWf from '../../../../.archon/workflows/defaults/archon-assist-codex.yaml' with { type: 'text' };
import archonComprehensivePrReviewWf from '../../../../.archon/workflows/defaults/archon-comprehensive-pr-review.yaml' with { type: 'text' };
import archonCreateIssueWf from '../../../../.archon/workflows/defaults/archon-create-issue.yaml' with { type: 'text' };
import archonFeatureDevelopmentWf from '../../../../.archon/workflows/defaults/archon-feature-development.yaml' with { type: 'text' };
import archonFixGithubIssueWf from '../../../../.archon/workflows/defaults/archon-fix-github-issue.yaml' with { type: 'text' };
import archonResolveConflictsWf from '../../../../.archon/workflows/defaults/archon-resolve-conflicts.yaml' with { type: 'text' };
import archonSmartPrReviewWf from '../../../../.archon/workflows/defaults/archon-smart-pr-review.yaml' with { type: 'text' };
import archonValidatePrWf from '../../../../.archon/workflows/defaults/archon-validate-pr.yaml' with { type: 'text' };
import archonRemotionGenerateWf from '../../../../.archon/workflows/defaults/archon-remotion-generate.yaml' with { type: 'text' };
import archonInteractivePrdWf from '../../../../.archon/workflows/defaults/archon-interactive-prd.yaml' with { type: 'text' };
import archonPivLoopWf from '../../../../.archon/workflows/defaults/archon-piv-loop.yaml' with { type: 'text' };
import archonPivLoopCodexWf from '../../../../.archon/workflows/defaults/archon-piv-loop-codex.yaml' with { type: 'text' };
import archonAdversarialDevWf from '../../../../.archon/workflows/defaults/archon-adversarial-dev.yaml' with { type: 'text' };
import archonWorkflowBuilderWf from '../../../../.archon/workflows/defaults/archon-workflow-builder.yaml' with { type: 'text' };

// =============================================================================
// Exports
// =============================================================================

/**
 * Bundled default commands - filename (without extension) -> content
 */
export const BUNDLED_COMMANDS: Record<string, string> = {
  'archon-assist': archonAssistCmd,
  'archon-assist-codex': archonAssistCodexCmd,
  'archon-code-review-agent': archonCodeReviewAgentCmd,
  'archon-comment-quality-agent': archonCommentQualityAgentCmd,
  'archon-compose-finalize-pr': archonComposeFinalizePrCmd,
  'archon-compose-pr': archonComposePrCmd,
  'archon-create-pr': archonCreatePrCmd,
  'archon-docs-impact-agent': archonDocsImpactAgentCmd,
  'archon-error-handling-agent': archonErrorHandlingAgentCmd,
  'archon-implement-issue': archonImplementIssueCmd,
  'archon-implement-review-fixes': archonImplementReviewFixesCmd,
  'archon-implement': archonImplementCmd,
  'archon-investigate-issue': archonInvestigateIssueCmd,
  'archon-pr-review-scope': archonPrReviewScopeCmd,
  'archon-ralph-prd': archonRalphPrdCmd,
  'archon-resolve-merge-conflicts': archonResolveMergeConflictsCmd,
  'archon-sync-pr-with-main': archonSyncPrWithMainCmd,
  'archon-synthesize-review': archonSynthesizeReviewCmd,
  'archon-test-coverage-agent': archonTestCoverageAgentCmd,
  'archon-validate-pr-code-review-feature': archonValidatePrCodeReviewFeatureCmd,
  'archon-validate-pr-code-review-main': archonValidatePrCodeReviewMainCmd,
  'archon-validate-pr-e2e-feature': archonValidatePrE2eFeatureCmd,
  'archon-validate-pr-e2e-main': archonValidatePrE2eMainCmd,
  'archon-validate-pr-report': archonValidatePrReportCmd,
};

export interface BundledScriptAsset {
  content: string;
  runtime: 'bun' | 'uv';
  extension: '.ts' | '.js' | '.py';
}

/**
 * Bundled default scripts - filename (without extension) -> runtime + content
 */
export const BUNDLED_SCRIPTS: Record<string, BundledScriptAsset> = {
  'detect-project': {
    content: detectProjectScript,
    runtime: 'bun',
    extension: '.ts',
  },
  'github-pr': {
    content: githubPrScript,
    runtime: 'bun',
    extension: '.ts',
  },
};

/**
 * Bundled default workflows - filename (without extension) -> content
 */
export const BUNDLED_WORKFLOWS: Record<string, string> = {
  'archon-assist': archonAssistWf,
  'archon-assist-codex': archonAssistCodexWf,
  'archon-comprehensive-pr-review': archonComprehensivePrReviewWf,
  'archon-create-issue': archonCreateIssueWf,
  'archon-feature-development': archonFeatureDevelopmentWf,
  'archon-fix-github-issue': archonFixGithubIssueWf,
  'archon-resolve-conflicts': archonResolveConflictsWf,
  'archon-smart-pr-review': archonSmartPrReviewWf,
  'archon-validate-pr': archonValidatePrWf,
  'archon-remotion-generate': archonRemotionGenerateWf,
  'archon-interactive-prd': archonInteractivePrdWf,
  'archon-piv-loop': archonPivLoopWf,
  'archon-piv-loop-codex': archonPivLoopCodexWf,
  'archon-adversarial-dev': archonAdversarialDevWf,
  'archon-workflow-builder': archonWorkflowBuilderWf,
};

/**
 * Check if the current process is running as a compiled binary (not via Bun CLI).
 *
 * Reads the build-time constant `BUNDLED_IS_BINARY` from `@archon/paths`.
 * `scripts/build-binaries.sh` rewrites that file to set it to `true` before
 * `bun build --compile` and restores it afterwards. See GitHub issue #979.
 *
 * Kept as a function (rather than a direct re-export of `BUNDLED_IS_BINARY`)
 * so tests can use `spyOn(bundledDefaults, 'isBinaryBuild').mockReturnValue(...)`
 * without resorting to `mock.module('@archon/paths', ...)` — which is
 * process-global and irreversible in Bun and would pollute other test files.
 * See `.claude/rules/dx-quirks.md` and `loader.test.ts` for context.
 */
export function isBinaryBuild(): boolean {
  return BUNDLED_IS_BINARY;
}
