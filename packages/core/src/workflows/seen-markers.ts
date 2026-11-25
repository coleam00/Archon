/**
 * The receipts that say a label or opened-issue read has been observed once. Their time is
 * the first-sight cutoff: what was already there then starts nothing. Split from
 * `source-plugins.ts`, which records and reads them.
 */
import { createHash } from 'node:crypto';
import type { SourceReceiptAcceptance } from '@archon/workflows/schemas/resource-start';
import type { ObservedLabelRead } from '@archon/workflows/webhook-source-plugin';

/**
 * The delivery id of the receipt that says a label read has been observed once, so the
 * labels already on issues then are recorded as seen and only a later add starts. A
 * persisted contract: changing it makes every label binding a first sight again.
 */
export function labelSeenMarker(read: ObservedLabelRead): string {
  return `observe:label-seen:${read.bindingId}:${read.repo.host}/${read.repo.path}:${read.label}`;
}

/**
 * The receipt id of a read's seen marker, derived from the source and the marker's delivery
 * id so a pass can read the marker, and its time, by id. A persisted contract as the
 * delivery id is. Shaped as a version 8 UUID, the version for ids built this way.
 */
export function seenMarkerId(sourceInstanceId: string, deliveryId: string): string {
  const hex = createHash('sha256').update(`${sourceInstanceId}\n${deliveryId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The unmatched receipt that records one read's first sight, at `cutoff`. */
export function seenMarkerAcceptance(
  sourceInstanceId: string,
  marker: { deliveryId: string; reason: string },
  cutoff: string
): SourceReceiptAcceptance {
  const { deliveryId, reason } = marker;
  return {
    receipt: {
      id: seenMarkerId(sourceInstanceId, deliveryId),
      sourceInstanceId,
      deliveryId,
      contentDigest: createHash('sha256').update(deliveryId).digest('hex'),
      receivedAt: new Date().toISOString(),
      // The cutoff later passes compare an add or an issue's creation with.
      occurredAt: cutoff,
      sourceActor: null,
    },
    outcome: 'unmatched',
    reason,
    bindings: [],
  };
}
