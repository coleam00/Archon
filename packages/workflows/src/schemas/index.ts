/**
 * Zod schemas for the workflow engine.
 *
 * All schemas are re-exported from this index.
 * Types are derived from schemas via `z.infer<typeof Schema>` (WorkflowDefinition
 * uses `Omit<z.infer<...>, 'nodes'>` because node parsing happens per-node in loader/node-parse.ts).
 *
 * Import `z` from plain `zod`; name OpenAPI components with `.meta({ id })`.
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
  modelRefSchema,
} from './model-binding';
export type {
  TierName,
  WorkflowModelRef,
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

export {
  preparedWorkflowLaunchSchema,
  resourceStartIntentSchema,
  resourceStartDispositionSchema,
  sourceReceiptInputSchema,
  resourceStartBindingIntentSchema,
} from './resource-start';
export type {
  PreparedWorkflowLaunch,
  ResourceStartIntent,
  ResourceStartDisposition,
  SourceReceiptInput,
  ResourceStartBindingIntent,
} from './resource-start';
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
  isNodeContextResume,
  isTriggerRule,
} from './dag-node-base';
export {
  nodeMcpSchema,
  mcpDeclaration,
  loopGroupNodeSchema,
  loopGroupNodeConfigSchema,
  MAX_DURABLE_WAIT_MS,
  dagNodeSchema,
  definedOutputPaths,
  KNOWN_DAG_NODE_KEYS,
  KNOWN_NODE_NESTED_KEYS,
  dagNodeFlatSchema,
  sandboxSettingsSchema,
  agentDefinitionSchema,
  piNodeConfigSchema,
} from './dag-node';
export { promptSourceSchema, agentNodeSchema } from './agent-node';
export { execNodeSchema } from './exec-node';
export { loopNodeSchema } from './loop-node';
export {
  decisionOptionSchema,
  gateNodeSchema,
  approvalOnRejectSchema,
  approvalConfigSchema,
} from './gate-node';
export { haltNodeSchema } from './halt-node';
export {
  waitConfigSchema,
  waitUntilTimestampSchema,
  waitNodeSchema,
  waitCondition,
  workflowWaitResultSchema,
  WAIT_NODE_OUTPUT_FORMAT,
} from './wait-node';
export {
  includeDirectiveSchema,
  composeFanOutConfigSchema,
  composeFanOutNodeSchema,
} from './include-node';
export { workflowNodeSchema, fanOutConfigSchema } from './workflow-node';
export {
  INPUT_NAME_SOURCE,
  inputEnvKey,
  bindingDirectiveSchema,
  isBindingDirective,
} from './node-bindings';
export {
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
} from './node-guards';
export { loopGroupOutputNodes, loopGroupSoleTerminalSink } from './loop-group-body';
export {
  ignoredFieldsForNode,
  isOutputFormatEnforced,
  BASH_NODE_AI_FIELDS,
  SCRIPT_NODE_AI_FIELDS,
  LOOP_NODE_AI_FIELDS,
  LOOP_GROUP_NODE_AI_FIELDS,
  INCLUDE_NODE_IGNORED_FIELDS,
  WAIT_NODE_IGNORED_FIELDS,
  WORKFLOW_NODE_IGNORED_FIELDS,
  GATE_AND_HALT_IGNORED_FIELDS,
} from './node-ignored-fields';
export {
  isPersistableNode,
  nodeUsesPersistedScope,
  runMayPersistSessions,
  persistedSessionHandling,
} from './node-session-persistence';
export type { TriggerRule, DagNodeBase, NodeContext } from './dag-node-base';
export type {
  NodeMcp,
  McpDeclaration,
  LoopGroupNode,
  LoopGroupNodeConfig,
  DagNode,
  SandboxSettings,
  AgentDefinition,
  PiNodeConfig,
  NestedKeySpec,
} from './dag-node';
export type { BindingDirective } from './node-bindings';
export type { PromptSource, AgentNode } from './agent-node';
export type { ExecNode } from './exec-node';
export type { LoopNode } from './loop-node';
export type { DecisionOption, GateNode, ApprovalOnReject } from './gate-node';
export type { HaltNode } from './halt-node';
export type { WaitConfig, WaitNode, WaitCondition, WorkflowWaitResult } from './wait-node';
export type { IncludeDirective, ComposeFanOutNode } from './include-node';
export type { WorkflowNode, FanOutConfig } from './workflow-node';

// Workflow definition
export {
  modelReasoningEffortSchema,
  webSearchModeSchema,
  workflowRequirementSchema,
  workflowEvidencePolicySchema,
  workflowRunBudgetSchema,
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
  WorkflowRunBudget,
  WorkflowInputSpec,
  WorkflowBase,
  WorkflowDefinition,
} from './workflow';

// Workflow run state
export {
  workflowRunStatusSchema,
  workflowRunOutcomeSchema,
  workflowWaitContextSchema,
  sessionCursorSchema,
  bodySessionCursorsSchema,
  bodySessionCursorAncestrySchema,
  type BodySessionCursorAncestry,
  scheduledWorkflowResumeSchema,
  workflowStepStatusSchema,
  nodeStateSchema,
  skipCauseSchema,
  nodeSkipReasonSchema,
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
  readWorkflowWaitContext,
  pendingWorkflowWaitDeadline,
  pausedUsageLimitWait,
  workflowWaitStepName,
  isScheduledWorkflowResume,
  readSourceRelease,
  isRunBlockedOnChild,
  isFanOutBlockReleased,
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
  EXECUTION_OWNER_METADATA_KEY,
  readExecutionOwner,
  RUN_DISPATCH_METADATA_KEY,
  runDispatchMetadataSchema,
  readRunDispatchMetadata,
} from './workflow-run';
export type {
  WorkflowRunStatus,
  WorkflowRunOutcome,
  WorkflowStepStatus,
  NodeState,
  SkipCause,
  NodeSkipReason,
  NodeOutput,
  WorkflowRun,
  ArtifactType,
  ApprovalContext,
  WorkflowAttentionWaitContext,
  WorkflowDeadlineWaitContext,
  WorkflowUsageLimitWaitContext,
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
  ExecutionOwnerRecord,
  RunDispatchMetadata,
} from './workflow-run';

// Per-node persisted provider sessions
export { workflowNodeSessionSchema, persistScopeKey } from './workflow-node-session';
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
  ParsedWorkflowLoadError,
  WorkflowLoadResult,
  GraphPlan,
  ResolvedWorkflow,
  WorkflowSource,
  WorkflowWithSource,
  DeclaredWorkflowConfig,
} from './workflow';

// DagWorkflow — alias kept for backward compatibility
export type { WorkflowDefinition as DagWorkflow } from './workflow';

export * from './workflow-run-listing';

export { workflowRunOriginSchema } from './workflow-run';
export {
  PAUSE_CAUSE_METADATA_KEY,
  pauseCauseSchema,
  pauseCauseOfApproval,
  pauseCauseOfWait,
  readPauseCause,
  type PauseCause,
} from './pause-cause';
export type { WorkflowRunOrigin } from './workflow-run';

export * from './workflow-event';

export {
  TOOL_CALL_ATTENTION_METADATA_KEY,
  toolCallAttentionSchema,
  toolCallAttentionArraySchema,
  type ToolCallAttention,
} from './workflow-run';

export type { SessionCursor } from './workflow-run';

export { canSuspend, isInteractiveSink } from './node-suspension';
