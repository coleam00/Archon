// Pull jsx.d.ts into downstream consumers' compilation so the ambient
// `declare global { namespace JSX }` is in scope for any tsx file resolved
// through this package's source entry (e.g. @archon/web, whose tsconfig
// `include` doesn't reach studio's src). Without this, downstream consumers
// see ~28 TS2503 errors across studio's .tsx files.
//
// Use a triple-slash directive (type-only) rather than `import './jsx'`: the
// latter resolves to `jsx.d.ts` only at type-check time and fails at runtime
// (Bun, Node) because there is no sibling .ts/.js file. Runtime consumers
// that route through this barrel (e.g. @archon/web's ExecutionNodeAdapter)
// otherwise hit a "cannot find module" error.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- pulling a .d.ts global augmentation into downstream compilation is exactly what this directive is for; an `import './jsx'` would fail at Bun runtime
/// <reference path="./jsx.d.ts" />

// Public surface for @archon-studio/core. Re-export only what consumers should use.
export const STUDIO_CORE_VERSION = '0.0.0';

export { ThemeProvider, type ThemePreset } from './theme/ThemeProvider';
export { ApiClientProvider, useWorkflowApi } from './api/ApiClientProvider';
export type {
  WorkflowApiClient,
  CodebaseInfo,
  WorkflowListItem,
  ValidateResult,
} from './api/WorkflowApiClient';
export type { WorkflowDefinition, DagNode } from './schemas';
export { workflowDefinitionSchema } from './schemas';
export { VARIANT_IDS, type VariantId } from './nodes/registry';
export { getVariant } from './nodes/default-registry';
export type { BuilderNode, DagNodeData, VariantDefinition } from './nodes/shared/types';

export { WorkflowBuilder, type WorkflowBuilderProps } from './components/WorkflowBuilder';
export { NodeInspector } from './components/inspector/NodeInspector';
export { VariantPicker } from './components/inspector/general/VariantPicker';

export { fromWorkflowDefinition } from './exporter/fromWorkflowDefinition';
export { toWorkflowDefinition } from './exporter/toWorkflowDefinition';
export { useBuilderStore } from './store/builder-store';
export type {
  BuilderState,
  WorkflowMeta,
  LoadWorkflowInput,
  IssuePath,
} from './store/builder-store';
export { useThemeStore } from './store/theme-store';
export { useUserLibraryStore } from './store/user-library-store';
export type { UserCommand, UserSnippet } from './store/user-library-store';
export { useUndoStore, withUndo, resetCoalesceState } from './store/undo-store';
export type { UndoSnapshot } from './store/undo-store';
export { ThemePicker } from './components/ThemePicker';

export { extractSubgraph } from './snippets/extractSubgraph';
export type { ExtractSubgraphResult } from './snippets/extractSubgraph';

export { useValidation } from './validation/useValidation';
export type { UseValidationResult } from './validation/useValidation';

export { serializeClipboard, parseClipboard } from './clipboard';
export type { ClipboardEnvelope } from './clipboard';

export {
  alignLeft,
  alignRight,
  alignTop,
  alignBottom,
  alignCenterH,
  alignCenterV,
  distributeH,
  distributeV,
} from './alignment';

export { computeGuides } from './smart-guides';
export type { Guide } from './smart-guides';
export { SmartGuidesLayer } from './components/SmartGuidesLayer';
