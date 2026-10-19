import type { ProviderDescriptor, ProviderRegistry } from '@archon/provider-contract';
import type { DagNode } from '../schemas';
import type { ResolvedAiProfile } from '../model-validation';
import type { ValidationConfig, ValidationIssue } from './types';

/** One `validateWorkflowResources` call: its inputs, and the issues found so far. */
export interface ResourceValidation {
  cwd: string;
  providers: ProviderRegistry;
  config: ValidationConfig | undefined;
  defaultProvider: string | undefined;
  /** Undefined when the tiers/aliases config cannot be built; that error is already an issue. */
  aiProfile: ResolvedAiProfile | undefined;
  /** Bundled, global and installed workflows run on installs whose custom aliases differ. */
  requiresPortableModelRefs: boolean;
  /** Flat command names, for did-you-mean hints. */
  availableCommands: readonly string[];
  issues: ValidationIssue[];
}

/** One node with the provider execution would give it. */
export interface NodeValidation {
  node: DagNode;
  provider: string | undefined;
  descriptor: ProviderDescriptor | undefined;
  capabilities: ProviderDescriptor['capabilities'] | undefined;
}
