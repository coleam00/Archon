import type {
  AgentDefinition as ClaudeAgentDefinition,
  EffortLevel as ClaudeEffortLevel,
  SandboxSettings as ClaudeSandboxSettings,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  OAuthAuthInfo as PiOAuthAuthInfo,
  OAuthDeviceCodeInfo as PiOAuthDeviceCodeInfo,
  OAuthLoginCallbacks as PiOAuthLoginCallbacks,
  OAuthCredentials as PiOAuthCredentials,
} from '@earendil-works/pi-ai/oauth';
import type { AgentDefinition, AssertNever } from '@archon/provider-contract';
import type { SandboxSettings } from '../../workflows/src/schemas/dag-node';
import type { EffortLevel } from '../../workflows/src/schemas/effort';
import type { OAuthCredentials } from '../../core/src/credentials/delivery';
import type {
  OAuthAuthInfo,
  OAuthDeviceCodeInfo,
  OAuthLoginCallbacks,
  SubscriptionOAuthCredentials,
} from '../../core/src/credentials/subscription-oauth';

type KnownFields<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

type SameValue<L, S> = [L] extends [S]
  ? [S] extends [L]
    ? never
    : 'different value'
  : 'different value';

// Boundary schemas expose a supported subset. Upstream additions and schema passthrough
// keys are intentional; dictionaries, nullability, and every declared field must agree.
type FieldDrift<L, S> =
  | SameValue<Extract<L, null | undefined>, Extract<S, null | undefined>>
  | ValueDrift<NonNullable<L>, NonNullable<S>>;

type ValueDrift<L, S> = [L] extends [readonly unknown[]]
  ? SameValue<L, S>
  : [L] extends [object]
    ? string extends keyof L
      ? SameValue<L, S>
      : [S] extends [object]
        ?
            | Exclude<keyof KnownFields<L>, keyof KnownFields<S>>
            | {
                [K in keyof KnownFields<L> & keyof KnownFields<S>]: FieldDrift<L[K], S[K]>;
              }[keyof KnownFields<L> & keyof KnownFields<S>]
        : 'different value'
    : SameValue<L, S>;

export type BoundaryConformance = {
  'packages/provider-contract/src/agent-provider.ts:AgentDefinition': AssertNever<
    FieldDrift<AgentDefinition, ClaudeAgentDefinition>
  >;
  'packages/workflows/src/schemas/dag-node.ts:SandboxSettings': AssertNever<
    FieldDrift<SandboxSettings, ClaudeSandboxSettings>
  >;
  'packages/workflows/src/schemas/effort.ts:EffortLevel': AssertNever<
    Exclude<ClaudeEffortLevel, EffortLevel>
  >;
  'packages/core/src/credentials/subscription-oauth.ts:OAuthAuthInfo': AssertNever<
    FieldDrift<OAuthAuthInfo, PiOAuthAuthInfo>
  >;
  'packages/core/src/credentials/subscription-oauth.ts:OAuthDeviceCodeInfo': AssertNever<
    FieldDrift<OAuthDeviceCodeInfo, PiOAuthDeviceCodeInfo>
  >;
  'packages/core/src/credentials/subscription-oauth.ts:OAuthLoginCallbacks': AssertNever<
    OAuthLoginCallbacks extends PiOAuthLoginCallbacks ? never : 'incompatible OAuth callbacks'
  >;
  'packages/core/src/credentials/delivery.ts:OAuthCredentials': AssertNever<
    | (PiOAuthCredentials extends OAuthCredentials ? never : 'incompatible stored credentials')
    | (SubscriptionOAuthCredentials extends PiOAuthCredentials
        ? never
        : 'incompatible subscription tokens')
  >;
};
