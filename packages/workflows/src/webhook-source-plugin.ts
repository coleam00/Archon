import { z } from 'zod';
import type {
  CommitChecksObservation,
  ForgeSubjectRef,
  PrReviewsObservation,
  WorkItemLabelAdded,
  WorkItemList,
} from '@archon/forge';
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

const observedLabelReadSchema = z
  .object({
    bindingId: z.string().min(1),
    repo: z.object({ host: z.string().min(1), path: z.string().min(1) }).strict(),
    label: z.string().min(1),
  })
  .strict();
/** One label a binding of a source starts on: the open issues and pull requests carrying it are listed. */
export type ObservedLabelRead = z.infer<typeof observedLabelReadSchema>;

/**
 * The label reads a source's bindings name, fixed when the plugin loads, so a plugin cannot
 * widen what it reads from one pass to the next. A label binding the source cannot observe
 * is `unserved`, with why.
 */
export const observedLabelsSchema = z
  .object({
    reads: z.array(observedLabelReadSchema),
    unserved: z
      .array(z.object({ bindingId: z.string().min(1), reason: z.string().min(1) }).strict())
      .default([]),
  })
  .strict();
export type ObservedLabels = z.input<typeof observedLabelsSchema>;

/**
 * The forge reads a source may make while it observes. Each refuses what nothing passed to
 * the same call names: a commit a wait is about; a pull request whose number ends the key
 * of an item a wait is on; the open items of a repository with a label a declared read
 * names; and when a label was added to an issue or pull request that list returned in the
 * same call, as the kind it was listed as.
 */
export interface SourceForgeReader {
  commitChecks(input: { remote: string; revision: string }): Promise<CommitChecksObservation>;
  prReviews(input: { remote: string; number: number }): Promise<PrReviewsObservation>;
  /** The open items with the label: issues and pull requests both. */
  issuesWithLabel(input: { repo: ObservedLabelRead['repo']; label: string }): Promise<WorkItemList>;
  labelAdded(input: {
    repo: ObservedLabelRead['repo'];
    kind: ForgeSubjectRef['kind'];
    number: number;
    label: string;
  }): Promise<WorkItemLabelAdded>;
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
    /**
     * The acceptances a label read made, each with the read it belongs to, so the engine
     * knows when every issue one read listed is recorded.
     */
    labelAcceptances: z
      .array(
        z
          .object({
            bindingId: z.string().min(1),
            label: z.string().min(1),
            acceptance: sourceReceiptAcceptanceSchema,
          })
          .strict()
      )
      .default([]),
    /** Label reads that failed, for one issue when `number` is set; the others still count. */
    labelFailures: z
      .array(
        z
          .object({
            bindingId: z.string().min(1),
            label: z.string().min(1),
            number: z.number().int().positive().optional(),
            reason: z.string().min(1),
          })
          .strict()
      )
      .default([]),
  })
  .strict();
export type SourceObservation = z.infer<typeof sourceObservationSchema>;

export interface WebhookSourcePlugin {
  receive(request: WebhookSourceRequest): Promise<WebhookSourceResult>;
  /** The label reads this source's bindings name, for `observe`; none when absent. */
  readonly observedLabels?: ObservedLabels;
  /**
   * The events a webhook would have delivered, for an install that receives none: for the
   * state the open waits name, and for the open issues carrying a label in `labels`. A wait
   * that names no binding of this source gets no entry; one this source binds but cannot
   * read is `unserved`, with why. `labels` holds only reads this source declared. A read's
   * `seenSince` is when the engine first saw it, or `null` on that first sight: a label
   * added before it is recorded as seen and starts nothing, and on the first sight every
   * label listed is.
   */
  observe?(input: {
    waits: readonly ObservedItemWait[];
    labels: readonly (ObservedLabelRead & { seenSince: string | null })[];
    forge: SourceForgeReader;
  }): Promise<SourceObservation>;
}

export type WebhookSourcePluginFactory = (input: {
  sourceInstanceId: string;
  config: unknown;
}) => WebhookSourcePlugin | Promise<WebhookSourcePlugin>;
