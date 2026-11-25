/**
 * The refs of the attention queue items no run holds: an ask a completed run left, the waits
 * it left, and the item it stopped. Each is built and read back only here. A run id is a
 * UUID, so no run ref takes any of these forms.
 */

const ASK_REF_PREFIX = 'ask:';

/**
 * The ref of an ask a completed run left. `askIdOfRef` reads it back; nothing else builds
 * or parses one. A run id is a UUID, so no run ref takes this form.
 */
export function askItemRef(askId: string): string {
  return `${ASK_REF_PREFIX}${askId}`;
}

/** The ask id an ask ref names, or undefined when the ref is not an ask's. */
export function askIdOfRef(ref: string): string | undefined {
  return ref.startsWith(ASK_REF_PREFIX) && ref.length > ASK_REF_PREFIX.length
    ? ref.slice(ASK_REF_PREFIX.length)
    : undefined;
}

const WAIT_REF_PREFIX = 'wait:';

/**
 * The ref of the waits a completed run left, as one item: the set is met, replaced or
 * withdrawn together. `waitRunIdOfRef` reads it back.
 */
export function waitItemRef(runId: string): string {
  return `${WAIT_REF_PREFIX}${runId}`;
}

/** The run a wait ref names, or undefined when the ref is not a wait's. */
export function waitRunIdOfRef(ref: string): string | undefined {
  return ref.startsWith(WAIT_REF_PREFIX) && ref.length > WAIT_REF_PREFIX.length
    ? ref.slice(WAIT_REF_PREFIX.length)
    : undefined;
}

const STOPPED_REF_PREFIX = 'stopped:';

/** The ref of the item a completed run stopped. `stoppedRunIdOfRef` reads it back. */
export function stoppedItemRef(runId: string): string {
  return `${STOPPED_REF_PREFIX}${runId}`;
}

/** The run a stopped item's ref names, or undefined when the ref is not a stopped item's. */
export function stoppedRunIdOfRef(ref: string): string | undefined {
  return ref.startsWith(STOPPED_REF_PREFIX) && ref.length > STOPPED_REF_PREFIX.length
    ? ref.slice(STOPPED_REF_PREFIX.length)
    : undefined;
}

const REFUSED_REF_PREFIX = 'refused:';

/** The ref of a refused start no run caused; nothing reads it back. */
export function refusedStartRef(receiptId: string, bindingId: string): string {
  return `${REFUSED_REF_PREFIX}${receiptId}:${bindingId}`;
}

const PREPARING_REF_PREFIX = 'preparing:';

/** The ref of a binding preparation whose preparer is gone; nothing reads it back. */
export function preparingItemRef(receiptId: string, bindingId: string): string {
  return `${PREPARING_REF_PREFIX}${receiptId}:${bindingId}`;
}

/** True when `ref` has the form of an item no run holds, open or closed. */
export function isItemWithoutRunRef(ref: string): boolean {
  return (
    askIdOfRef(ref) !== undefined ||
    waitRunIdOfRef(ref) !== undefined ||
    stoppedRunIdOfRef(ref) !== undefined ||
    (ref.startsWith(REFUSED_REF_PREFIX) && ref.length > REFUSED_REF_PREFIX.length) ||
    (ref.startsWith(PREPARING_REF_PREFIX) && ref.length > PREPARING_REF_PREFIX.length)
  );
}
