import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from '@archon/paths';
import {
  USER_CONTROLLED_VARIABLES,
  type UserControlledVariableContext,
} from './user-controlled-variables';
import {
  inputRefToken,
  substituteTemplate,
  templateToken,
  type JsonValue,
  type TemplateToken,
} from './output-ref';

/** Lazy-initialized logger, under the executor-shared name these events have always carried. */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.executor-shared');
  return cachedLog;
}

/**
 * Scope holding the current run's adopted artifact directory (#2747), entered by
 * the executor around DAG execution. A scoped context rather than another
 * positional parameter because the value is RUN-level (like `artifactsDir`) but
 * is consumed at every substitution site several layers down; a child sub-run's
 * `executeWorkflow` re-enters with its own (absent) scope, correctly shadowing
 * the parent's adoption.
 */
const adoptedRunDirContext = new AsyncLocalStorage<string | undefined>();

export function runWithAdoptedRunDir<T>(
  adoptedRunDir: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  return adoptedRunDirContext.run(adoptedRunDir, fn);
}

export function currentAdoptedRunDir(): string | undefined {
  return adoptedRunDirContext.getStore();
}

const contextVariables = USER_CONTROLLED_VARIABLES.filter(group => group.kind === 'context').map(
  group => ({ ...group, pattern: `\\$(?:${group.names.join('|')})(?![A-Za-z0-9_])` })
);

/** Pattern string for context variables - used to create fresh regex instances */
export const CONTEXT_VAR_PATTERN_STR = contextVariables.map(group => group.pattern).join('|');

/**
 * Reference grammars resolved in the same pass as the workflow variables, so nothing a
 * variable inserts is scanned again (#4046). `before` wins a `$` a workflow variable could
 * also match (an enclosing loop_group's `$LOOP_USER_INPUT` over the run-level one); `after`
 * loses it (`$node.output` references).
 */
export interface TemplateReferences {
  before: readonly TemplateToken[];
  after: readonly TemplateToken[];
}

/**
 * Substitute workflow variables in a prompt.
 *
 * Supported variables:
 * - $WORKFLOW_ID - The workflow run ID
 * - $USER_MESSAGE, $ARGUMENTS - The user's trigger message
 * - $ARTIFACTS_DIR - External artifacts directory for this workflow run
 * - $STATE_DIR - External per-PROJECT cross-run state directory (shared by every
 *   workflow in the project; pre-created by the executor). Throws if referenced
 *   without a resolved value.
 * - $ADOPTED_RUN_DIR (#2747) - The adopted run's artifact directory, resolved
 *   through its persisted `output_root`. Read-only by contract; throws if
 *   referenced without an adoption active.
 * - $TYPED_ARTIFACTS_FILE - The consumer's typed-artifact observation (JSON). Throws
 *   if referenced by a context that never materialized one (see below).
 * - $BASE_BRANCH - The base branch (from config or auto-detected)
 * - $CONTEXT, $EXTERNAL_CONTEXT, $ISSUE_CONTEXT - GitHub issue/PR context (if available)
 * - $DOCS_DIR - Documentation directory path (configured or default 'docs/')
 * - $LOOP_USER_INPUT - User feedback from interactive loop approval. Only populated on the
 *   first iteration of a resumed interactive loop; empty string on all other iterations.
 * - $REJECTION_REASON - Reviewer feedback from approval node rejection (on_reject prompts only).
 * - $LOOP_PREV_OUTPUT - Cleaned output of the previous loop iteration. Empty string on the
 *   first iteration (no prior output exists). Useful for fresh_context loops that need
 *   to reference what the previous pass produced or why it failed.
 * - $INPUTS.<name> - Named sub-run inputs (#2470), supplied by a caller's `with:` on a
 *   `workflow:` node. Resolved from `options.inputs` in the non-shell branch only; an
 *   unknown name THROWS. Shell (bash/script) nodes read `INPUTS_<UPPER_SNAKE>` env vars.
 *
 * Every variable and every `options.references` grammar resolves in one scan of the
 * template: a substituted value is inserted verbatim and never read as template syntax.
 *
 * When issueContext is undefined, context variables are replaced with empty string
 * to avoid sending literal "$CONTEXT" to the AI.
 */
export function substituteWorkflowVariables(
  prompt: string,
  workflowId: string,
  userMessage: string,
  artifactsDir: string,
  baseBranch: string,
  docsDir: string,
  issueContext?: string,
  loopUserInput?: string,
  rejectionReason?: string,
  loopPrevOutput?: string,
  options?: {
    shellSafe?: boolean;
    stateDir?: string;
    inputs?: Record<string, JsonValue>;
    /** Adopted run's artifact directory (#2747). Undefined = no adoption active. */
    adoptedRunDir?: string;
    /**
     * The consumer's typed-artifact observation path. Undefined means the caller never
     * supplied one (a coordination node, or a wiring bug) and a prompt that references
     * `$TYPED_ARTIFACTS_FILE` throws. An explicit `''` is a caller stating it has no
     * listing — the dry-run preview — and substitutes empty without throwing.
     */
    typedArtifactsFile?: string;
    references?: TemplateReferences;
  }
): { prompt: string; contextSubstituted: boolean } {
  const variable = (name: string, value: () => string): TemplateToken =>
    templateToken(`\\$${name}`, value);

  const tokens: TemplateToken[] = [
    variable('WORKFLOW_ID', () => workflowId),
    variable('ARTIFACTS_DIR', () => artifactsDir),
    // Engine-controlled like $ARTIFACTS_DIR — substituted even under shellSafe,
    // or `bash:`/`script:` bodies would never see it. The state directory is threaded
    // from the executor to every substitution site; a site that forgot to pass it would
    // otherwise leave the variable literal (AI nodes) or empty (shell nodes), silently
    // writing state to the wrong place. Loud beats silent.
    variable('STATE_DIR', () => {
      if (!options?.stateDir) {
        throw new Error(
          '$STATE_DIR is referenced but no state directory was resolved for this run. ' +
            '$STATE_DIR is only available inside a workflow run; if you are seeing this from a workflow node, ' +
            'please report it as a bug.'
        );
      }
      return options.stateDir;
    }),
    // $ADOPTED_RUN_DIR (#2747) resolves only under an explicit adoption. A run
    // that references it without one throws — mirroring $BASE_BRANCH/$STATE_DIR —
    // because a literal or empty substitution would silently point work at
    // nothing instead of telling the author the run was never started with --adopt.
    variable('ADOPTED_RUN_DIR', () => {
      if (!options?.adoptedRunDir && !currentAdoptedRunDir()) {
        throw new Error(
          '$ADOPTED_RUN_DIR is referenced but this run did not adopt a prior run. ' +
            'Start it with `workflow run <name> --adopt <run-id>` (or adopt_run_id on the API) ' +
            "to read an earlier run's artifacts by reference."
        );
      }
      return options?.adoptedRunDir ?? currentAdoptedRunDir() ?? '';
    }),
    // $TYPED_ARTIFACTS_FILE is delivered by every executable invocation context (bash,
    // script, agent prompt, loop attempt), and to exec subprocesses as TYPED_ARTIFACTS_FILE.
    // A context that never supplied one must fail loudly: substituting '' would read as
    // "no typed artifacts", which is the exact silent-empty lookup this contract exists to
    // remove. An explicit empty string is different — a caller that knows it has no
    // listing (the dry-run preview) says so.
    variable('TYPED_ARTIFACTS_FILE', () => {
      if (options?.typedArtifactsFile === undefined) {
        throw new Error(
          '$TYPED_ARTIFACTS_FILE is referenced but this invocation has no typed-artifact listing. ' +
            'It is available inside bash, script, agent, loop, and approval-rework nodes; ' +
            'if you are seeing this from one of those, please report it as a bug.'
        );
      }
      return options.typedArtifactsFile;
    }),
    variable('BASE_BRANCH', () => {
      if (!baseBranch) {
        throw new Error(
          'No base branch could be resolved for this run, but $BASE_BRANCH is referenced. ' +
            'For a new run, pass --base <branch>, set `worktree.baseBranch` in .archon/config.yaml, or set the codebase default branch. ' +
            'An isolated child that reused a branch without its original child run record has no known base; start a new parent run. ' +
            'See https://archon.diy/reference/variables/#base_branch-fail-fast'
        );
      }
      return baseBranch;
    }),
    // Defensive: ensure docsDir always has a value (callers should resolve, but guard here)
    variable('DOCS_DIR', () => docsDir || 'docs/'),
  ];

  // When shellSafe is true, user-controlled variables stay literal — they are passed via
  // subprocess environment variables instead to prevent shell injection (#2115).
  if (!options?.shellSafe) {
    const values: UserControlledVariableContext = {
      userMessage,
      loopUserInput,
      rejectionReason,
      loopPrevOutput,
      issueContext,
    };
    tokens.push(
      ...USER_CONTROLLED_VARIABLES.filter(group => group.kind === 'text').flatMap(group =>
        group.names.map(name => variable(name, () => values[group.source] ?? ''))
      )
    );
    tokens.push(
      // $INPUTS.<name> — named sub-run inputs (#2470). Non-shell branch ONLY: a sub-run's
      // input value can derive from AI output (e.g. `with: {plan: $plan.output}`), the
      // exact user-controlled class shellSafe keeps out of shell source (#2115). An
      // unknown name THROWS (mirrors $node.output.field strictness) rather than
      // substituting '' — a typo'd input silently emptying is worse than a load-visible error.
      inputRefToken(options?.inputs)
    );
    for (const group of contextVariables) {
      tokens.push(templateToken(group.pattern, () => values[group.source] ?? ''));
    }
  }

  const hasContextVariables = new RegExp(CONTEXT_VAR_PATTERN_STR).test(prompt);
  if (!options?.shellSafe && !issueContext && hasContextVariables) {
    getLog().debug(
      {
        action: 'clearing variables',
        variables: contextVariables.flatMap(group => group.names.map(name => `$${name}`)),
      },
      'context_variables_cleared'
    );
  }

  const references = options?.references;
  return {
    prompt: substituteTemplate(prompt, [
      ...(references?.before ?? []),
      ...tokens,
      ...(references?.after ?? []),
    ]),
    contextSubstituted: hasContextVariables && !!issueContext,
  };
}

/**
 * Apply variable substitution and optionally append issue context.
 * Appends context only if it wasn't already substituted via $CONTEXT variables.
 * This prevents duplicate context being sent to the AI.
 *
 * @param template - The command prompt template with variable placeholders
 * @param workflowId - The workflow run ID for variable substitution
 * @param userMessage - The user's trigger message for variable substitution
 * @param artifactsDir - The external artifacts directory for $ARTIFACTS_DIR substitution
 * @param baseBranch - The resolved base branch for $BASE_BRANCH substitution
 * @param docsDir - The resolved docs directory for $DOCS_DIR substitution
 * @param issueContext - Optional GitHub issue/PR context to substitute or append
 * @param logLabel - Human-readable label for logging (e.g., 'workflow step prompt')
 * @param options - Forwarded to {@link substituteWorkflowVariables}; carries `stateDir`
 *   for `$STATE_DIR` and `typedArtifactsFile` for `$TYPED_ARTIFACTS_FILE`, each of
 *   which throws when referenced without one, `rejectionReason` for
 *   `$REJECTION_REASON`, and the `references` resolved in the same pass.
 * @returns The final prompt with variables substituted and context optionally appended
 */
export function buildPromptWithContext(
  template: string,
  workflowId: string,
  userMessage: string,
  artifactsDir: string,
  baseBranch: string,
  docsDir: string,
  issueContext: string | undefined,
  logLabel: string,
  options?: {
    shellSafe?: boolean;
    stateDir?: string;
    inputs?: Record<string, JsonValue>;
    typedArtifactsFile?: string;
    rejectionReason?: string;
    references?: TemplateReferences;
  }
): string {
  const { rejectionReason, ...variableOptions } = options ?? {};
  const { prompt, contextSubstituted } = substituteWorkflowVariables(
    template,
    workflowId,
    userMessage,
    artifactsDir,
    baseBranch,
    docsDir,
    issueContext,
    undefined,
    rejectionReason,
    undefined,
    variableOptions
  );

  if (issueContext && !contextSubstituted) {
    getLog().debug({ logLabel }, 'issue_context_appended');
    return prompt + '\n\n---\n\n' + issueContext;
  }

  return prompt;
}
