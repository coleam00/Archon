import { z } from 'zod';

/**
 * Why a provider turn failed, as the provider classified it from its SDK's structured
 * signals (status codes, error classes, typed events). The engine decides retry from this
 * class alone:
 *  - `auth`             credentials missing, rejected or expired. Never retried.
 *  - `quota_exhausted`  a usage or credit window is used up. Never retried; `resetAt` says when it reopens.
 *  - `budget_exceeded`  the run's spend limit stopped the turn. Never retried.
 *  - `rate_limited`     the vendor is shedding load. Retried with the patient rate-limit budget.
 *  - `transient`        network, overload or process failure that a new attempt may clear.
 *  - `unknown`          the provider knows the turn failed but not why. Retried only on `on_error: all`.
 */
export const providerFailureClassSchema = z.enum([
  'auth',
  'quota_exhausted',
  'budget_exceeded',
  'rate_limited',
  'transient',
  'unknown',
]);
export type ProviderFailureClass = z.infer<typeof providerFailureClassSchema>;

export const providerFailureSchema = z.object({
  class: providerFailureClassSchema,
  /** Vendor-advised wait before the next attempt, in milliseconds. */
  retryAfterMs: z.number().int().nonnegative().optional(),
  /** When an exhausted quota window reopens. */
  resetAt: z.iso.datetime({ offset: true }).optional(),
  /**
   * The vendor's own words or code, kept for the operator and the logs. Diagnostic only:
   * nothing may branch on it, because a vendor rewording must never change behaviour.
   */
  evidence: z.string().min(1),
});
export type ProviderFailure = z.infer<typeof providerFailureSchema>;
