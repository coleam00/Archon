export type SdkTypeException = {
  file: string;
  name: string;
  reason: string;
} & (
  | { kind: 'independent' }
  | {
      kind: 'boundary';
      sdkModule: string;
      comparison: 'fields' | 'sdk-subset' | 'local-subset';
      conformanceTest: typeof CONFORMANCE;
    }
);

export const CONFORMANCE = 'scripts/sdk-type-conformance.test.ts';

export const SDK_TYPE_EXCEPTIONS: readonly SdkTypeException[] = [
  {
    file: '.archon/scripts/__tests__/intake.test.ts',
    name: 'Event',
    kind: 'independent',
    reason: 'Synthetic forge intake event, not an OpenCode event.',
  },
  {
    file: 'packages/chat-slack/src/test/slack.ts',
    name: 'Command',
    kind: 'independent',
    reason: 'Derived Slack Bolt command handler, not an OpenCode command.',
  },
  {
    file: 'packages/cli/src/commands/workflow-shared.ts',
    name: 'WorkflowRunOptions',
    kind: 'independent',
    reason: 'Archon CLI dispatch flags, not Copilot workflow execution options.',
  },
  {
    file: 'packages/core/src/credentials/delivery.ts',
    name: 'OAuthCredentials',
    kind: 'boundary',
    reason:
      'Unvalidated encrypted vendor blobs must accept legacy and vendor-specific data; Pi token credentials are a narrower supported subset. Core stays SDK-free.',
    sdkModule: '@earendil-works/pi-ai/oauth',
    comparison: 'sdk-subset',
    conformanceTest: CONFORMANCE,
  },
  {
    file: 'packages/core/src/credentials/subscription-oauth.ts',
    name: 'OAuthAuthInfo',
    kind: 'boundary',
    reason: 'Core-owned subscription authorization callback stays SDK-free.',
    sdkModule: '@earendil-works/pi-ai/oauth',
    comparison: 'fields',
    conformanceTest: CONFORMANCE,
  },
  {
    file: 'packages/core/src/credentials/subscription-oauth.ts',
    name: 'OAuthDeviceCodeInfo',
    kind: 'boundary',
    reason:
      'Core subscription flow uses the device-code fields shared with Pi, without its optional timing hints.',
    sdkModule: '@earendil-works/pi-ai/oauth',
    comparison: 'fields',
    conformanceTest: CONFORMANCE,
  },
  {
    file: 'packages/core/src/credentials/subscription-oauth.ts',
    name: 'OAuthLoginCallbacks',
    kind: 'boundary',
    reason:
      'Core callbacks accept Pi prompts but require manual code input and allow unlabeled selection options. Core stays SDK-free.',
    sdkModule: '@earendil-works/pi-ai/oauth',
    comparison: 'local-subset',
    conformanceTest: CONFORMANCE,
  },
  {
    file: 'packages/core/src/db/state-documents.ts',
    name: 'Query',
    kind: 'independent',
    reason: 'Derived IDatabase query method, not a Claude streaming query.',
  },
  {
    file: 'packages/core/src/db/workflow-events.commit-order.postgres.integration.test.ts',
    name: 'Session',
    kind: 'independent',
    reason: 'PostgreSQL client and backend PID test handle, not an OpenCode session.',
  },
  {
    file: 'packages/core/src/providers/scoped-config.ts',
    name: 'JsonSchema',
    kind: 'independent',
    reason: 'Derived Zod JSON schema including boolean schemas, not OpenCode tool schema.',
  },
  {
    file: 'packages/core/src/schemas/session.ts',
    name: 'SessionMetadata',
    kind: 'independent',
    reason: 'Archon persisted last-command metadata, not Copilot session metadata.',
  },
  {
    file: 'packages/core/src/schemas/session.ts',
    name: 'Session',
    kind: 'independent',
    reason: 'Archon database session row derived from its Zod schema, not an OpenCode session.',
  },
  {
    file: 'packages/isolation/src/pr-state.test.ts',
    name: 'ExecResult',
    kind: 'independent',
    reason: 'Git subprocess test result with stdout/stderr, not Pi extension execution output.',
  },
  {
    file: 'packages/provider-contract/src/agent-provider.ts',
    name: 'AgentDefinition',
    kind: 'boundary',
    reason: 'SDK-free inline-agent schema exposes a supported subset of Claude agent settings.',
    sdkModule: '@anthropic-ai/claude-agent-sdk',
    comparison: 'fields',
    conformanceTest: CONFORMANCE,
  },
  {
    file: 'packages/server/src/index.ts',
    name: 'ServerOptions',
    kind: 'independent',
    reason: 'Archon host startup options, not OpenCode server launch options.',
  },
  {
    file: 'packages/server/src/routes/api.workflow-runs.ts',
    name: 'WorkflowRunStatus',
    kind: 'independent',
    reason: 'Derived Archon workflow-run schema status, not Copilot workflow status.',
  },
  {
    file: 'packages/server/src/routes/api.artifacts.ts',
    name: 'FileEntry',
    kind: 'independent',
    reason: 'Artifact HTTP response with size and modification time, not Pi file-tree entry.',
  },
  {
    file: 'packages/web/src/experiments/console/builder/types/variant.ts',
    name: 'WorkflowMeta',
    kind: 'independent',
    reason: 'Derived generated Archon workflow API metadata, not Copilot workflow metadata.',
  },
  {
    file: 'packages/web/src/experiments/console/primitives/event.ts',
    name: 'ToolCallEvent',
    kind: 'independent',
    reason:
      'Normalized persisted Archon run-event view with result and timestamp, not a Pi extension hook payload.',
  },
  {
    file: 'packages/web/src/experiments/console/primitives/event.ts',
    name: 'ErrorEvent',
    kind: 'independent',
    reason: 'Normalized Archon run error view, not a Copilot session error.',
  },
  {
    file: 'packages/web/src/experiments/console/primitives/message.ts',
    name: 'Message',
    kind: 'independent',
    reason: 'Archon chat message view from generated API types, not a provider model message.',
  },
  {
    file: 'packages/web/src/experiments/console/primitives/project.ts',
    name: 'Project',
    kind: 'independent',
    reason: 'Archon codebase view with repository URL and default branch, not an OpenCode project.',
  },
  {
    file: 'packages/web/src/experiments/console/primitives/workflow.ts',
    name: 'WorkflowInput',
    kind: 'independent',
    reason: 'Archon authoring input description, not a Claude workflow-tool invocation.',
  },
  {
    file: 'packages/web/src/experiments/console/primitives/worktree.ts',
    name: 'Worktree',
    kind: 'independent',
    reason: 'Archon isolation environment view with lifecycle status, not an OpenCode worktree.',
  },
  {
    file: 'packages/workflows/src/engine-port.ts',
    name: 'WorkflowResumeOptions',
    kind: 'independent',
    reason:
      'Archon engine resume restrictions derived from its dispatch contract, not Copilot workflow resume options.',
  },
  {
    file: 'packages/workflows/src/output-ref.ts',
    name: 'JsonValue',
    kind: 'independent',
    reason:
      'Engine-owned JSON value domain for workflow bindings and validation; generic JSON vocabulary, not a provider boundary copy.',
  },
  {
    file: 'packages/workflows/src/schemas/provider-options.ts',
    name: 'SandboxSettings',
    kind: 'boundary',
    reason:
      'SDK-free workflow schema validates known Claude sandbox fields and passes through additional settings.',
    sdkModule: '@anthropic-ai/claude-agent-sdk',
    comparison: 'fields',
    conformanceTest: CONFORMANCE,
  },
  {
    file: 'packages/workflows/src/schemas/agent-node.ts',
    name: 'PromptSource',
    kind: 'independent',
    reason: 'Archon prompt file/text union, not an OpenCode message source.',
  },
  {
    file: 'packages/workflows/src/schemas/effort.ts',
    name: 'EffortLevel',
    kind: 'boundary',
    reason:
      'Derived portable Archon effort ladder includes every Claude effort value and additional provider rungs; workflows stay SDK-free.',
    sdkModule: '@anthropic-ai/claude-agent-sdk',
    comparison: 'sdk-subset',
    conformanceTest: CONFORMANCE,
  },
  {
    file: 'packages/workflows/src/schemas/run-status.ts',
    name: 'WorkflowRunStatus',
    kind: 'independent',
    reason: 'Persisted Archon run-state schema, not Copilot workflow status.',
  },
  {
    file: 'packages/workflows/src/schemas/workflow.ts',
    name: 'WorkflowDefinition',
    kind: 'independent',
    reason: 'Archon validated YAML workflow graph, not a Copilot workflow definition.',
  },
  {
    file: 'packages/workflows/src/scripts/generate-node-execution-reference.ts',
    name: 'JsonSchema',
    kind: 'independent',
    reason: 'Derived Zod JSON schema for documentation generation, not OpenCode tool schema.',
  },
  {
    file: 'scripts/validate.ts',
    name: 'Command',
    kind: 'independent',
    reason: 'Shell argument tuple for repository validation, not an OpenCode command.',
  },
];
