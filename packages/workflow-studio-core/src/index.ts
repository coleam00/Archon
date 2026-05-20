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
export { useUndoStore, withUndo, resetCoalesceState } from './store/undo-store';
export type { UndoSnapshot } from './store/undo-store';
export { ThemePicker } from './components/ThemePicker';

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
