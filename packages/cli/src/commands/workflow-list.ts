import { findRepoRoot } from '@archon/git';
import { resolveCodebaseForPath } from '@archon/core/services/codebase-checkout-resolver';
import { createCliWorkflowHost } from '../utils/workflow-host';
import { getLog } from './workflow-shared';
import { loadConfig } from '@archon/core/config/config-loader';
import { providerRegistry } from '@archon/providers';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import type { WorkflowLoadResult } from '@archon/workflows/schemas/workflow';

/**
 * Load workflows from the DISCOVERY root with standardized error handling.
 *
 * The root passed here owns both the workflow files and the `defaults:` /
 * `commands.folder` settings that govern how they are discovered — a workflow's own
 * checkout decides which command folder its command nodes name. What the run then DOES
 * is governed separately by the target's config, loaded inside `executeWorkflow`.
 */
export async function loadWorkflows(
  cwd: string,
  options: { reportIgnoredFiles?: boolean } = {}
): Promise<WorkflowLoadResult> {
  try {
    // Home-scoped workflows at ~/.archon/workflows/ are discovered automatically —
    // no option needed since the discovery helper reads them unconditionally.
    if (!options.reportIgnoredFiles)
      return await discoverWorkflowsWithConfig(cwd, loadConfig, providerRegistry);
    const diagnostics = await resolveIgnoreDiagnostics(cwd);
    const result = await discoverWorkflowsWithConfig(cwd, loadConfig, providerRegistry, undefined, {
      gitIgnoreRoot: diagnostics.root,
    });
    return diagnostics.warning
      ? { ...result, sourceWarnings: [...(result.sourceWarnings ?? []), diagnostics.warning] }
      : result;
  } catch (error) {
    const err = error as Error;
    throw new Error(
      `Error loading workflows: ${err.message}\nHint: Check permissions on .archon/workflows/ directory.`
    );
  }
}

async function resolveIgnoreDiagnostics(cwd: string): Promise<{ root?: string; warning?: string }> {
  try {
    const host = await createCliWorkflowHost();
    const { repoRoot } = await resolveCodebaseForPath(cwd, host.records.codebases);
    return { root: repoRoot ?? undefined };
  } catch (error) {
    getLog().warn({ err: error }, 'cli.workflow_source_project_lookup_failed');
    try {
      // As with discovery cwd resolution, local authoring works without registration storage.
      return { root: (await findRepoRoot(cwd)) ?? undefined };
    } catch (gitError) {
      getLog().warn({ err: gitError }, 'cli.workflow_source_ignore_check_failed');
      return { warning: 'Could not determine the project checkout for the Git ignore check.' };
    }
  }
}

export interface WorkflowJsonEntry {
  name: string;
  description: string;
  descriptionTruncated: boolean;
  provider?: string;
  /** A model ref, or a preference list of `@alias` refs ending in a tier or model id. */
  model?: string | readonly string[];
  /** Reasoning depth — the one spelling, on every provider that has one (#2556).
   *  A workflow written with the deprecated `modelReasoningEffort:` reports its
   *  value here, since the loader translates the two into one field. */
  effort?: string;
  webSearchMode?: string;
  /** Keys the workflow's YAML declares that the engine drops (#2213). */
  parseWarnings?: string[];
}

const WORKFLOW_DESCRIPTION_PREVIEW_LIMIT = 160;
export const WORKFLOW_DESCRIPTION_TRUNCATION_MARKER = ' [truncated]';

interface WorkflowDescriptionProjection {
  description: string;
  truncated: boolean;
}

export function projectWorkflowDescription(
  description: string,
  full: boolean
): WorkflowDescriptionProjection {
  if (full || Array.from(description).length <= WORKFLOW_DESCRIPTION_PREVIEW_LIMIT) {
    return { description, truncated: false };
  }

  const normalized = description.trim().replace(/\s+/gu, ' ');
  const codePoints = Array.from(normalized);
  if (codePoints.length <= WORKFLOW_DESCRIPTION_PREVIEW_LIMIT) {
    return { description: normalized, truncated: true };
  }

  const firstSentenceEnd = codePoints
    .slice(0, WORKFLOW_DESCRIPTION_PREVIEW_LIMIT)
    .findIndex(character => character === '.' || character === '?' || character === '!');
  if (firstSentenceEnd !== -1) {
    return {
      description: codePoints.slice(0, firstSentenceEnd + 1).join(''),
      truncated: true,
    };
  }

  let preview = codePoints.slice(0, WORKFLOW_DESCRIPTION_PREVIEW_LIMIT);
  if (codePoints[WORKFLOW_DESCRIPTION_PREVIEW_LIMIT] !== ' ') {
    const lastWordBoundary = preview.lastIndexOf(' ');
    if (lastWordBoundary > 0) preview = preview.slice(0, lastWordBoundary);
  }
  return { description: preview.join(''), truncated: true };
}
