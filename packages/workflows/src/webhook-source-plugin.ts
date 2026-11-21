import { z } from 'zod';
import type { CommitChecksObservation } from '@archon/forge';
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
  /** The repository URL of the project of the run that left the wait, when it has one. */
  remote: string | null;
}

/** The forge reads a source may make while it observes waits. */
export interface SourceForgeReader {
  /** The checks at one commit. Refuses a commit that no wait passed to the same call names. */
  commitChecks(input: { remote: string; revision: string }): Promise<CommitChecksObservation>;
}

export const sourceObservationSchema = z
  .object({
    acceptances: z.array(sourceReceiptAcceptanceSchema),
    unserved: z.array(
      z
        .object({
          wait: z.object({ workflowName: z.string(), event: z.string(), about: z.string() }),
          reason: z.string().min(1),
        })
        .strict()
    ),
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
