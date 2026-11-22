import { z } from 'zod';
import type { CommitChecksObservation, PrReviewsObservation } from '@archon/forge';
import { sourceReceiptAcceptanceSchema } from './schemas/resource-start';

export interface WebhookSourceRequest {
  body: string;
  headers: Record<string, string>;
  receivedAt: string;
}

export const webhookSourceResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('rejected'), reason: z.literal('unauthenticated') }).strict(),
  z.object({ status: z.literal('received'), acceptance: sourceReceiptAcceptanceSchema }).strict(),
]);
export type WebhookSourceResult = z.infer<typeof webhookSourceResultSchema>;

/** An open item wait, as the engine hands it to a source that observes waits. */
export interface ObservedItemWait {
  workflowName: string;
  event: string;
  about: string;
  /** The key of the item the wait is on. */
  itemKey: string;
  /** The repository URL of the project of the run that left the wait, when it has one. */
  remote: string | null;
}

/**
 * The forge reads a source may make while it observes waits. Each refuses what no wait
 * passed to the same call names: a commit a wait is about, or a pull request whose number
 * ends the key of an item a wait is on.
 */
export interface SourceForgeReader {
  commitChecks(input: { remote: string; revision: string }): Promise<CommitChecksObservation>;
  prReviews(input: { remote: string; number: number }): Promise<PrReviewsObservation>;
}

const observedWaitSchema = z
  .object({ workflowName: z.string(), event: z.string(), about: z.string(), itemKey: z.string() })
  .strict();

export const sourceObservationSchema = z
  .object({
    acceptances: z.array(sourceReceiptAcceptanceSchema),
    /** Waits this source binds but cannot observe, with why. */
    unserved: z.array(z.object({ wait: observedWaitSchema, reason: z.string().min(1) }).strict()),
    /** Reads that failed; the other waits are still observed. */
    failed: z.array(z.object({ wait: observedWaitSchema, reason: z.string().min(1) }).strict()),
  })
  .strict();
export type SourceObservation = z.infer<typeof sourceObservationSchema>;

export interface WebhookSourcePlugin {
  receive(request: WebhookSourceRequest): Promise<WebhookSourceResult>;
  /**
   * The events a webhook would have delivered for the state the open waits name, for an
   * install that receives none. A wait that names no binding of this source gets no entry;
   * one this source binds but cannot read is `unserved`, with why.
   */
  observe?(input: {
    waits: readonly ObservedItemWait[];
    forge: SourceForgeReader;
  }): Promise<SourceObservation>;
}

export type WebhookSourcePluginFactory = (input: {
  sourceInstanceId: string;
  config: unknown;
}) => WebhookSourcePlugin | Promise<WebhookSourcePlugin>;
