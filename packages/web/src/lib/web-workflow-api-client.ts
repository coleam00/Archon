/**
 * Thin adapter implementing studio's `WorkflowApiClient` interface by delegating
 * to Archon's existing typed `@/lib/api` layer.
 *
 * Why a thin adapter instead of studio's `ArchonApiClient`:
 *   - Archon's web client already opens its own relative-URL `fetch` (Vite proxy in dev,
 *     same-origin in prod) and throws a standard `Error` with `.status` attached.
 *     Plugging studio's class in would create two parallel HTTP stacks in one bundle.
 *
 * Translation strategy:
 *   - Every mapping is one direction (Archon response -> studio contract shape) and is
 *     small enough to inline. No shared "translation layer" abstraction (YAGNI).
 *   - `listCodebases` honors studio's `null`-on-404 contract; Archon always exposes the
 *     endpoint, so this branch is portability-only.
 *   - `saveWorkflow` argument-order asymmetry: studio uses `(name, cwd, definition)`;
 *     Archon's `api.saveWorkflow` is `(name, definition, cwd)`. The adapter reorders.
 *
 * This file is the only place in `@archon/web` that imports `@archon/workflow-studio-core`.
 */

import * as api from '@/lib/api';
import type {
  WorkflowApiClient,
  CodebaseInfo,
  WorkflowListItem,
  ValidateResult,
  WorkflowDefinition,
} from '@archon/workflow-studio-core';

type ApiNamespace = typeof api;

const VALID_SOURCES = ['project', 'global', 'bundled'] as const;
type ValidSource = (typeof VALID_SOURCES)[number];

/**
 * Fail-fast guard. Throws if the server returned a `source` outside the known union.
 * The shape should already be narrowed by the OpenAPI-generated types at compile
 * time, so this only catches a server contract drift at runtime.
 */
function assertWorkflowSource(v: string): asserts v is ValidSource {
  if (!(VALID_SOURCES as readonly string[]).includes(v)) {
    throw new Error(
      `WebWorkflowApiClient: unexpected workflow source '${v}'. Expected one of: ${VALID_SOURCES.join(', ')}.`
    );
  }
}

export interface WebWorkflowApiClientOptions {
  /** Optional override used only by tests. Default: live `@/lib/api` namespace. */
  apiNamespace?: ApiNamespace;
}

export class WebWorkflowApiClient implements WorkflowApiClient {
  private readonly api: ApiNamespace;

  constructor(opts: WebWorkflowApiClientOptions = {}) {
    this.api = opts.apiNamespace ?? api;
  }

  async listCodebases(): Promise<CodebaseInfo[] | null> {
    try {
      const rows = await this.api.listCodebases();
      return rows.map(r => ({ id: r.id, name: r.name, default_cwd: r.default_cwd }));
    } catch (error) {
      if ((error as { status?: number }).status === 404) {
        return null;
      }
      throw error;
    }
  }

  async listWorkflows(cwd: string): Promise<WorkflowListItem[]> {
    const entries = await this.api.listWorkflows(cwd);
    return entries.map(entry => {
      assertWorkflowSource(entry.source);
      return { workflow: entry.workflow as WorkflowDefinition, source: entry.source };
    });
  }

  async listCommands(
    cwd: string
  ): Promise<{ name: string; source: 'project' | 'global' | 'bundled' }[]> {
    const entries = await this.api.listCommands(cwd);
    return entries.map(entry => {
      assertWorkflowSource(entry.source);
      return { name: entry.name, source: entry.source };
    });
  }

  async listProviders(): Promise<{ id: string; capabilities: Record<string, boolean> }[]> {
    const providers = await this.api.listProviders();
    return providers.map(p => ({ id: p.id, capabilities: p.capabilities }));
  }

  async getWorkflow(name: string, cwd: string): Promise<WorkflowDefinition> {
    const result = await this.api.getWorkflow(name, cwd);
    return result.workflow as WorkflowDefinition;
  }

  async saveWorkflow(
    name: string,
    cwd: string,
    definition: WorkflowDefinition
  ): Promise<WorkflowDefinition> {
    // Argument-order asymmetry: studio's `saveWorkflow(name, cwd, definition)` vs
    // Archon's `api.saveWorkflow(name, definition, cwd)`. Reorder happens here.
    const result = await this.api.saveWorkflow(name, definition as api.WorkflowDefinition, cwd);
    return result.workflow as WorkflowDefinition;
  }

  async deleteWorkflow(name: string, cwd: string): Promise<void> {
    await this.api.deleteWorkflow(name, cwd);
  }

  async validateWorkflow(definition: WorkflowDefinition): Promise<ValidateResult> {
    // Archon's validate endpoint is /api/workflows/validate; studio's ArchonApiClient
    // assumed /api/validate. We use Archon's path via @/lib/api so no redirection
    // logic is needed here.
    return this.api.validateWorkflow(definition as api.WorkflowDefinition);
  }

  async ping(): Promise<{ ok: true; serverVersion?: string }> {
    const result = await this.api.getHealth();
    return { ok: true, serverVersion: result.version };
  }
}

export function createWebWorkflowApiClient(
  opts?: WebWorkflowApiClientOptions
): WebWorkflowApiClient {
  return new WebWorkflowApiClient(opts);
}
