import type { OAuthCredentials as PiOAuthCredentials } from '@earendil-works/pi-ai/oauth';
import type { AssertNever } from '@archon/provider-contract';
import type { SubscriptionOAuthCredentials } from '../../core/src/credentials/subscription-oauth';

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
export type FieldDrift<L, S> =
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

export type SubscriptionTokenConformance = AssertNever<
  SubscriptionOAuthCredentials extends PiOAuthCredentials
    ? never
    : 'incompatible subscription tokens'
>;
