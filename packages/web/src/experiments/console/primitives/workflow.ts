import type { WireWorkflowDefinition } from '../builder/types/wire';
import type { components } from '@/lib/api.generated';

/**
 * Where a workflow lives — engine-known (`project` / `global` / `bundled`).
 * Derived from the generated OpenAPI schema (`@/lib/api.generated`) so the
 * union cannot silently drift between this primitive and the server. #2578
 * closed a hand-maintained mirror here that collapsed unrecognised values to
 * `'bundled'`; the precedent is the same fix PR #2570 made for `CommandGroup`
 * (`packages/web/src/lib/command-groups.ts`). The console's lint guard
 * disallows named imports from `@/lib/api`, so the type is sourced from the
 * generated file directly (the `packages/web/src/lib/api.ts` re-export
 * carries the same bytes either way).
 */
export type WorkflowSource = components['schemas']['WorkflowSource'];

/**
 * One entry of a workflow's declared `inputs:` signature (#2470), flattened for
 * rendering. A run supplies values for these; an omitted name takes `default`, and a
 * `required` one with no value is refused before the run starts (#2554).
 */
type WorkflowInputSpec = NonNullable<components['schemas']['WorkflowDefinition']['inputs']>[string];

export interface WorkflowInput {
  name: string;
  required: NonNullable<WorkflowInputSpec['required']>;
  default: string | null;
  description: NonNullable<WorkflowInputSpec['description']> | null;
}

export interface Workflow {
  name: components['schemas']['WorkflowDefinition']['name'];
  description: components['schemas']['WorkflowDefinition']['description'] | null;
  /**
   * Where the workflow came from. Known values carry `WorkflowSource` literals
   * so the downstream helpers (`isReadOnlySource`, `saveTargetFor`) keep their
   * type-narrowed callers; the `(string & {})` widening surfaces an
   * unrecognised value verbatim rather than collapsing it to `'bundled'`,
   * which would silently mark it read-only and turn Save into Save-as
   * (#2578). The `& {}` keeps the known literals visible in autocomplete.
   */
  source: WorkflowSource | (string & {});
  /**
   * Keys this workflow's YAML declares that the engine silently drops (#2213).
   * Empty for a clean workflow. The workflow still loads and runs — this is what
   * was ignored, which can include a gate the author believed they had.
   */
  parseWarnings: NonNullable<components['schemas']['WorkflowListEntry']['parseWarnings']>;
  /** Declared `inputs:` in declaration order; empty when the workflow declares none. */
  inputs: WorkflowInput[];
}

type RawWorkflowShape = Pick<components['schemas']['WorkflowDefinition'], 'name'> &
  Partial<Pick<components['schemas']['WorkflowDefinition'], 'description' | 'inputs' | 'returns'>>;
type RawWorkflowEntry = Pick<components['schemas']['WorkflowListEntry'], 'parseWarnings'> & {
  workflow: RawWorkflowShape;
  source: Workflow['source'];
};

export function toWorkflow(raw: RawWorkflowEntry): Workflow {
  // Pass the raw source through verbatim. Three distinct sources matter for
  // sort + badge — project (repo-local) > global (home-scoped
  // `~/.archon/workflows`) > bundled (defaults shipped with Archon) — but
  // an unrecognised value must not be collapsed to `'bundled'` (that would
  // mark it read-only and turn Save into Save-as, #2578). Mirrors
  // `groupCommandsBySource` in `@/lib/command-groups.ts` (#2570): surface
  // unknown values rather than hide them.
  const src: WorkflowSource | (string & {}) = raw.source;
  // Object key order preserves the YAML's declaration order for string keys, so the
  // run form renders inputs in the order the author wrote them.
  const inputs: WorkflowInput[] = Object.entries(raw.workflow.inputs ?? {}).map(([name, spec]) => ({
    name,
    required: spec?.required === true,
    default:
      spec?.default == null
        ? null
        : typeof spec.default === 'string'
          ? spec.default
          : (JSON.stringify(spec.default) ?? null),
    description: spec?.description ?? null,
  }));
  return {
    name: raw.workflow.name,
    description: raw.workflow.description ?? null,
    source: src,
    parseWarnings: raw.parseWarnings ?? [],
    inputs,
  };
}

/** Discovered workflows plus the repo-curated recommended names (declared order). */
export interface WorkflowListResult {
  workflows: Workflow[];
  recommended: components['schemas']['WorkflowListResponse']['recommended'];
}

/** Normalized result of `loadWorkflow`. */
export interface LoadedWorkflow {
  definition: WireWorkflowDefinition;
  filename: components['schemas']['GetWorkflowResponse']['filename'];
  /**
   * Where the workflow came from. Same widening rationale as
   * `Workflow.source`: an unrecognised value reaches the editor
   * verbatim and the downstream helpers (`isReadOnlySource`, `saveTargetFor`)
   * — both accepting `string` — decide what to do with it.
   */
  source: Workflow['source'];
}

/**
 * An installed-pack workflow (`owner/plugin:entrypoint`). The server resolves it through
 * the catalog and returns no authored form, so the builder shows it as read-only instead
 * of opening an editor on it.
 */
export interface InstalledPackWorkflow {
  installedPack: true;
  name: components['schemas']['WorkflowDefinition']['name'];
}

/** What `loadWorkflow` resolves to: a definition to edit, or a pack workflow that has none. */
export type WorkflowLoad = LoadedWorkflow | InstalledPackWorkflow;
