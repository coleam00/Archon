import { z } from 'zod';
import { resourceStartDispositionSchema, sourceReceiptInputSchema } from './schemas/resource-start';

declare const admissionNoticeCursorBrand: unique symbol;
/** A durable admission position, interpreted only by the issuing store. */
export type AdmissionNoticeCursor = string & { readonly [admissionNoticeCursorBrand]: true };

export function admissionNoticeCursor(text: string): AdmissionNoticeCursor {
  return text as AdmissionNoticeCursor;
}

/** Engine-owned facts projected from a skipped request and its explicit delivery. */
export const admissionNoticeFactsSchema = z.object({
  requestId: z.string(),
  receiptId: z.string(),
  bindingId: z.string(),
  resource: z.string(),
  overlap: z.literal('skip'),
  blocker: resourceStartDispositionSchema.options[1].shape.blocker,
  deliveryId: z.string(),
  receivedAt: sourceReceiptInputSchema.shape.receivedAt,
  sourceActor: sourceReceiptInputSchema.shape.sourceActor,
  codebaseId: z.string(),
  cwd: z.string(),
});
export type AdmissionNoticeFacts = z.infer<typeof admissionNoticeFactsSchema>;

export interface AdmissionNoticePage {
  notices: readonly { cursor: AdmissionNoticeCursor; facts: AdmissionNoticeFacts }[];
  /** Includes exhausted scan positions only when every notice in the page is accepted. */
  next: AdmissionNoticeCursor;
  caughtUp: boolean;
}

export function validateAdmissionNoticeLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new RangeError('limit must be a positive integer');
}
