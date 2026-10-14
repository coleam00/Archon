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

// Boundary schemas expose a supported subset. Ignore upstream additions and passthrough
// index signatures, but compare every explicitly declared field, including nested fields.
type FieldDrift<L, S> =
  | Exclude<keyof KnownFields<L>, keyof KnownFields<S>>
  | {
      [K in keyof KnownFields<L> & keyof KnownFields<S>]:
        | SameValue<undefined extends L[K] ? true : false, undefined extends S[K] ? true : false>
        | (NonNullable<L[K]> extends readonly unknown[]
            ? SameValue<L[K], S[K]>
            : NonNullable<L[K]> extends object
              ? FieldDrift<NonNullable<L[K]>, NonNullable<S[K]>>
              : SameValue<L[K], S[K]>);
    }[keyof KnownFields<L> & keyof KnownFields<S>];

export type AgentFieldsConform = AssertNever<FieldDrift<AgentDefinition, ClaudeAgentDefinition>>;
export type SandboxFieldsConform = AssertNever<FieldDrift<SandboxSettings, ClaudeSandboxSettings>>;
export type ClaudeEffortIsPortable = AssertNever<Exclude<ClaudeEffortLevel, EffortLevel>>;
export type AuthInfoConforms = AssertNever<FieldDrift<OAuthAuthInfo, PiOAuthAuthInfo>>;
export type DeviceCodeConforms = AssertNever<
  FieldDrift<OAuthDeviceCodeInfo, PiOAuthDeviceCodeInfo>
>;
export type CoreCallbacksAcceptPi = AssertNever<
  OAuthLoginCallbacks extends PiOAuthLoginCallbacks ? never : 'incompatible OAuth callbacks'
>;
export type DeliveryAcceptsPiTokens = AssertNever<
  PiOAuthCredentials extends OAuthCredentials ? never : 'incompatible stored credentials'
>;
export type SubscriptionTokensConform = AssertNever<
  SubscriptionOAuthCredentials extends PiOAuthCredentials
    ? never
    : 'incompatible subscription tokens'
>;
