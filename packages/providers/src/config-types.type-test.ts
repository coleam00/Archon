import type { SETTING_SOURCES } from '@archon/paths/skills';
import type { NodeConfig } from '@archon/provider-contract';
import type { z } from 'zod';
import type { AssertNever, PiExtensionPosture } from '@archon/provider-contract';
import type {
  ClaudeProviderDefaults,
  CodexProviderDefaults,
  CopilotProviderDefaults,
  OpencodeProviderDefaults,
  PiProviderDefaults,
} from './types';
import type { configSchemas as claudeSchemas } from './claude/config';
import type { configSchemas as codexSchemas } from './codex/config';
import type { configSchemas as copilotSchemas } from './community/copilot/config';
import type { configSchema as opencodeSchema } from './community/opencode/config';
import type { configSchemas as piSchemas } from './community/pi/config';

/** `never` when both types have the same keys and accept each other's values. */
type Mismatch<A, B> =
  | Exclude<keyof A, keyof B>
  | Exclude<keyof B, keyof A>
  | ([A] extends [B] ? ([B] extends [A] ? never : 'value mismatch') : 'value mismatch');

// Each provider's defaults type is its install schema's output. A hand-written
// type that drifts from the schema, including by an index signature, fails here.
export type ClaudeDefaultsMatchSchema = AssertNever<
  Mismatch<ClaudeProviderDefaults, z.output<typeof claudeSchemas.install>>
>;
export type CodexDefaultsMatchSchema = AssertNever<
  Mismatch<CodexProviderDefaults, z.output<typeof codexSchemas.install>>
>;
export type CopilotDefaultsMatchSchema = AssertNever<
  Mismatch<CopilotProviderDefaults, z.output<typeof copilotSchemas.install>>
>;
export type OpencodeDefaultsMatchSchema = AssertNever<
  Mismatch<OpencodeProviderDefaults, z.output<typeof opencodeSchema>>
>;
export type PiDefaultsMatchSchema = AssertNever<
  Mismatch<PiProviderDefaults, z.output<typeof piSchemas.install>>
>;

// A per-node override is resolved as the contract's posture.
export type PiNodeOverrideMatchesContract = AssertNever<
  Mismatch<NonNullable<PiProviderDefaults['nodes']>[string], PiExtensionPosture>
>;

// The contract does not depend on paths; this conformance check binds their vocabularies.
export type SettingSourcesMatchContract = AssertNever<
  Mismatch<NonNullable<NodeConfig['settingSources']>, (typeof SETTING_SOURCES)[number][]>
>;
