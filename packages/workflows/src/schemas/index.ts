/**
 * Zod schemas for the workflow engine.
 *
 * All schemas are re-exported from this index.
 * Types are derived from schemas via `z.infer<typeof Schema>` (WorkflowDefinition
 * uses `Omit<z.infer<...>, 'nodes'>` because node parsing happens per-node in loader.ts).
 *
 * Import `z` from `@hono/zod-openapi` in all schema files (project convention).
 */

// Retry configuration
export { stepRetryConfigSchema } from './retry';
export type { StepRetryConfig } from './retry';

// Loop node configuration
export { loopNodeConfigSchema, loopControlSchema } from './loop';
export type { LoopNodeConfig, LoopControl } from './loop';

// Hooks
export {
  workflowHookEventSchema,
  workflowHookMatcherSchema,
  workflowNodeHooksSchema,
  WORKFLOW_HOOK_EVENTS,
} from './hooks';
export type { WorkflowHookEvent, WorkflowHookMatcher, WorkflowNodeHooks } from './hooks';

export { effortLevelSchema, EFFORT_LEVELS } from './effort';
export type { EffortLevel } from './effort';

// Model binding profiles and durable run metadata
export {
  TIER_NAMES,
  tierNameSchema,
  modelAliasPresetSchema,
  rawAliasesConfigSchema,
  runAliasesConfigSchema,
  rawTiersConfigSchema,
  resolvedRunModelOverridesSchema,
  resolvedAiProfileSchema,
  runModelBindingsMetadataSchema,
} from './model-binding';
export type {
  TierName,
  ModelAliasPreset,
  RawAliasEntry,
  RawAliasesConfig,
  RawTiersConfig,
  ResolvedRunModelOverrides,
  ResolvedAiProfile,
  RunModelBindingsMetadata,
} from './model-binding';

// Sparse, durable configuration for one workflow invocation
export {
  workflowRunContinuationConfigSchema,
  workflowRunConfigLayerSchema,
  workflowRunConfigSourceSchema,
  workflowRunConfigInputSchema,
  workflowRunConfigMetadataSchema,
} from './run-config';
export type {
  WorkflowRunConfigLayer,
  WorkflowRunConfigSource,
  WorkflowRunConfigInput,
  WorkflowRunConfigMetadata,
} from './run-config';

// DAG node types
export {
  triggerRuleSchema,
  TRIGGER_RULES,
  dagNodeBaseSchema,
  nodeContextSchema,
  promptSourceSchema,
  agentNodeSchema,
  execNodeSchema,
  loopNodeSchema,
  loopGroupNodeSchema,
  loopGroupNodeConfigSchema,
  decisionOptionSchema,
  gateNodeSchema,
  approvalOnRejectSchema,
  haltNodeSchema,
  MAX_DURABLE_WAIT_MS,
  waitConfigSchema,
  waitUntilTimestampSchema,
  waitNodeSchema,
  waitCondition,
  workflowWaitResultSchema,
  WAIT_NODE_OUTPUT_FORMAT,
  includeDirectiveSchema,
  workflowNodeSchema,
  fanOutConfigSchema,
  composeFanOutConfigSchema,
  composeFanOutNodeSchema,
  dagNodeSchema,
  INPUT_NAME_SOURCE,
  inputEnvKey,
  bindingDirectiveSchema,
  isBindingDirective,
  isAgentNode,
  isExecNode,
  isGateNode,
  isHaltNode,
  isWaitNode,
  isLoopNode,
  isLoopGroupNode,
  isWorkflowNode,
  isComposeFanOutNode,
  isIncludeDirective,
  ignoredFieldsForNode,
  isOutputFormatEnforced,
  isPersistableNode,
  isNodeContextResume,
  isTriggerRule,
  BASH_NODE_AI_FIELDS,
  SCRIPT_NODE_AI_FIELDS,
  LOOP_NODE_AI_FIELDS,
  LOOP_GROUP_NODE_AI_FIELDS,
  INCLUDE_NODE_IGNORED_FIELDS,
  WAIT_NODE_IGNORED_FIELDS,
  WORKFLOW_NODE_IGNORED_FIELDS,
  GATE_AND_HALT_IGNORED_FIELDS,
  KNOWN_DAG_NODE_KEYS,
  KNOWN_NODE_NESTED_KEYS,
  approvalConfigSchema,
  dagNodeFlatSchema,
  sandboxSettingsSchema,
  agentDefinitionSchema,
  piNodeConfigSchema,
} from './dag-node';
export type {
  TriggerRule,
  DagNodeBase,
  NodeContext,
  BindingDirective,
  PromptSource,
  AgentNode,
  ExecNode,
  LoopNode,
  LoopGroupNode,
  LoopGroupNodeConfig,
  DecisionOption,
  GateNode,
  ApprovalOnReject,
  HaltNode,
  WaitConfig,
  WaitNode,
  WaitCondition,
  WorkflowWaitResult,
  IncludeDirective,
  WorkflowNode,
  ComposeFanOutNode,
  FanOutConfig,
  DagNode,
  SandboxSettings,
  AgentDefinition,
  PiNodeConfig,
  NestedKeySpec,
} from './dag-node';

// Workflow definition
export {
  modelReasoningEffortSchema,
  webSearchModeSchema,
  workflowRequirementSchema,
  workflowEvidencePolicySchema,
  workflowInputSpecSchema,
  workflowBaseSchema,
  workflowDefinitionSchema,
  KNOWN_WORKFLOW_KEYS,
  KNOWN_WORKFLOW_NESTED_KEYS,
  WORKFLOW_ONLY_KEYS,
} from './workflow';
export type {
  ModelReasoningEffort,
  WebSearchMode,
  WorkflowRequirement,
  WorkflowEvidencePolicy,
  WorkflowInputSpec,
  WorkflowBase,
  WorkflowDefinition,
} from './workflow';

// Workflow run state
export {
  workflowRunStatusSchema,
  workflowRunOutcomeSchema,
  workflowWaitContextSchema,
  scheduledWorkflowResumeSchema,
  workflowStepStatusSchema,
  nodeStateSchema,
  skipCauseSchema,
  nodeOutputSchema,
  workflowRunSchema,
  artifactTypeSchema,
  TERMINAL_WORKFLOW_STATUSES,
  RESUMABLE_WORKFLOW_STATUSES,
  isApprovalContext,
  isGateResolved,
  isTerminalRunStatus,
  runAttention,
  isWorkflowWaitContext,
  workflowWaitStepName,
  isScheduledWorkflowResume,
  isRunBlockedOnChild,
  suspendReasonSchema,
  isRecognizedSuspendReason,
  reRunsOwnNodeOnResume,
  SUBRUN_METADATA_KEYS,
  readSubrunMetadata,
  RUN_METADATA_KEYS,
  readIdentityUnresolved,
  WORKFLOW_SOURCE_METADATA_KEY,
  workflowSourceConfigSchema,
  workflowSourceMetadataSchema,
  readWorkflowSourceState,
  CONTINUATION_METADATA_KEY,
  readContinuationMode,
} from './workflow-run';
export type {
  WorkflowRunStatus,
  WorkflowRunOutcome,
  WorkflowStepStatus,
  NodeState,
  SkipCause,
  NodeOutput,
  WorkflowRun,
  ArtifactType,
  ApprovalContext,
  WorkflowAttentionWaitContext,
  WorkflowWaitContext,
  ScheduledWorkflowResume,
  SuspendReason,
  RunTerminalStatus,
  RunAttention,
  RunAttentionInput,
  RunAttentionUnreadableReason,
  GateAddress,
  LoopGateRunMetadata,
  WorkflowSourceMetadata,
  WorkflowSourceConfig,
  WorkflowSourceState,
  ContinuationMode,
} from './workflow-run';

// Per-node persisted provider sessions
export { workflowNodeSessionSchema } from './workflow-node-session';
export type { WorkflowNodeSession } from './workflow-node-session';

// Private provider session handles scoped to one workflow run
export { workflowRunNodeSessionSchema } from './workflow-run-node-session';
export type { WorkflowRunNodeSession } from './workflow-run-node-session';

// Node typed-output artifacts (output_type metadata)
export { nodeArtifactSchema, nodeArtifactLoopFrameSchema } from './node-artifact';
export type { NodeArtifact, NodeArtifactLoopFrame } from './node-artifact';

// Result types (non-schema hand-written types)
export type {
  LoadCommandResult,
  WorkflowExecutionResult,
  WorkflowLoadError,
  WorkflowLoadResult,
  GraphPlan,
  ResolvedWorkflow,
  WorkflowSource,
  WorkflowWithSource,
  DeclaredWorkflowConfig,
} from './workflow';

// DagWorkflow — alias kept for backward compatibility
export type { WorkflowDefinition as DagWorkflow } from './workflow';
