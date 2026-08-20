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

// DAG node types
export {
  triggerRuleSchema,
  TRIGGER_RULES,
  dagNodeBaseSchema,
  nodeContextSchema,
  commandNodeSchema,
  promptNodeSchema,
  bashNodeSchema,
  loopNodeSchema,
  loopGroupNodeSchema,
  loopGroupNodeConfigSchema,
  approvalNodeSchema,
  approvalOnRejectSchema,
  cancelNodeSchema,
  scriptNodeSchema,
  includeNodeSchema,
  workflowNodeSchema,
  fanOutConfigSchema,
  dagNodeSchema,
  INPUT_NAME_SOURCE,
  inputEnvKey,
  isCommandNode,
  isPromptNode,
  isBashNode,
  isLoopNode,
  isLoopGroupNode,
  isApprovalNode,
  isCancelNode,
  isScriptNode,
  isIncludeNode,
  isWorkflowNode,
  isPersistableNode,
  isNodeContextResume,
  isTriggerRule,
  BASH_NODE_AI_FIELDS,
  SCRIPT_NODE_AI_FIELDS,
  LOOP_NODE_AI_FIELDS,
  LOOP_GROUP_NODE_AI_FIELDS,
  INCLUDE_NODE_IGNORED_FIELDS,
  WORKFLOW_NODE_IGNORED_FIELDS,
  KNOWN_DAG_NODE_KEYS,
  KNOWN_NODE_NESTED_KEYS,
  approvalConfigSchema,
  dagNodeFlatSchema,
  effortLevelSchema,
  thinkingConfigSchema,
  sandboxSettingsSchema,
  agentDefinitionSchema,
  piNodeConfigSchema,
} from './dag-node';
export type {
  TriggerRule,
  DagNodeBase,
  NodeContext,
  CommandNode,
  PromptNode,
  BashNode,
  LoopNode,
  LoopGroupNode,
  LoopGroupNodeConfig,
  ApprovalNode,
  ApprovalOnReject,
  CancelNode,
  ScriptNode,
  IncludeNode,
  WorkflowNode,
  FanOutConfig,
  DagNode,
  EffortLevel,
  ThinkingConfig,
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
  workflowStepStatusSchema,
  nodeStateSchema,
  nodeOutputSchema,
  workflowRunSchema,
  artifactTypeSchema,
  TERMINAL_WORKFLOW_STATUSES,
  RESUMABLE_WORKFLOW_STATUSES,
  isApprovalContext,
  isRunBlockedOnChild,
  SUBRUN_METADATA_KEYS,
  readSubrunMetadata,
} from './workflow-run';
export type {
  WorkflowRunStatus,
  WorkflowRunOutcome,
  WorkflowStepStatus,
  NodeState,
  NodeOutput,
  WorkflowRun,
  ArtifactType,
  ApprovalContext,
  LoopGateRunMetadata,
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

// Fan-out child outcome observability (#2451)
export {
  FAN_OUT_EXCERPT_MAX_CHARS,
  FAN_OUT_ATTENTION_LINE_CAP,
  fanOutExcerpt,
  childNeverRanReasonSchema,
  fanOutEngineCancelReasonSchema,
  childDispositionSchema,
  fanOutReportPayloadSchema,
  fanOutTallySchema,
  tallyChildDispositions,
  parseFanOutReport,
  formatFanOutHeadline,
  formatFanOutBreakdown,
  formatFanOutTally,
  neverRan,
  ranFailed,
  toChildDisposition,
  buildFanOutReportPayload,
  formatChildDispositionLine,
  fanOutViewSchema,
  toFanOutView,
} from './fan-out-report';
export type {
  ChildNeverRanReason,
  FanOutEngineCancelReason,
  ChildDisposition,
  FanOutReportPayload,
  FanOutTally,
  FanOutReport,
  FanOutView,
  ChildRanOutcome,
  ChildNeverRanOutcome,
  ChildWorkflowOutcome,
} from './fan-out-report';

// Result types (non-schema hand-written types)
export type {
  LoadCommandResult,
  WorkflowExecutionResult,
  WorkflowLoadError,
  WorkflowLoadResult,
  WorkflowSource,
  WorkflowWithSource,
  DeclaredWorkflowConfig,
} from './workflow';

// DagWorkflow — alias kept for backward compatibility
export type { WorkflowDefinition as DagWorkflow } from './workflow';
