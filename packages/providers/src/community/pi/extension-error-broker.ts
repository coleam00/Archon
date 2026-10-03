import { createLogger } from '@archon/paths';
import type { ExtensionError } from '@earendil-works/pi-coding-agent';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.pi.extension-error-broker');
  return cachedLog;
}

export interface PiExtensionTurn {
  onError(listener: (error: Error) => void): () => void;
  report(error: Error, extensionPath: string, evidence?: string): void;
  reportStructured(error: ExtensionError): void;
  throwIfFailed(): void;
  /** End process-error attribution before a successful terminal result becomes visible. */
  stopAccepting(): void;
  close(): void;
}

const failureEvidence = new WeakMap<Error, string>();
interface ActiveTurn {
  readonly extensionPaths: readonly string[];
  /** Names the turn in logs; the workflow node id when the turn has one. */
  readonly owner: string | undefined;
}

/** Turns that still accept process errors. */
const activeTurns = new Map<PiExtensionTurn, ActiveTurn>();

/**
 * A frame names a path only where the path ends: at its line/column, a closing paren,
 * whitespace, the frame end, or a `/` into a directory extension. A bare substring
 * would let `/x/ext.ts` claim a frame in `/x/ext.tsx`.
 */
function frameNamesPath(frame: string, path: string): boolean {
  for (let index = frame.indexOf(path); index !== -1; index = frame.indexOf(path, index + 1)) {
    const next = frame.charAt(index + path.length);
    if (next === '' || next === ':' || next === ')' || next === '/' || next.trim() === '') {
      return true;
    }
  }
  return false;
}

function matchingExtensionPath(
  error: Error,
  extensionPaths: readonly string[]
): string | undefined {
  const stackFrames = error.stack?.split('\n').slice(1);
  if (!stackFrames) return undefined;
  return extensionPaths.find(path => stackFrames.some(frame => frameNamesPath(frame, path)));
}

/**
 * Start one extension-enabled Pi turn. Turns run concurrently: a detached process
 * error is routed by the extension paths in its stack (see claimPiExtensionProcessError).
 */
export function beginPiExtensionTurn(
  extensionPaths: readonly string[],
  owner?: string
): PiExtensionTurn {
  let failed: Error | undefined;
  let closed = false;
  const listeners = new Set<(error: Error) => void>();

  const report = (
    error: Error,
    extensionPath: string,
    evidence = error.stack ?? error.message
  ): void => {
    failureEvidence.set(error, evidence);
    getLog().error({ err: error, extensionPath }, 'pi.extension_turn_failed');
    if (failed) return;
    failed = error;
    for (const listener of listeners) listener(error);
  };

  const turn: PiExtensionTurn = {
    onError(listener) {
      if (failed) listener(failed);
      else listeners.add(listener);
      return () => listeners.delete(listener);
    },
    report,
    reportStructured(extensionError) {
      const error = new Error(
        `Pi extension '${extensionError.extensionPath}' failed during '${extensionError.event}': ${extensionError.error}`
      );
      if (extensionError.stack) error.stack = extensionError.stack;
      const evidence = extensionError.stack
        ? `${error.message}\n${extensionError.stack}`
        : error.message;
      report(error, extensionError.extensionPath, evidence);
    },
    throwIfFailed() {
      if (failed) throw failed;
    },
    stopAccepting() {
      activeTurns.delete(turn);
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      turn.stopAccepting();
    },
  };

  activeTurns.set(turn, {
    extensionPaths: [...new Set(extensionPaths.filter(path => path.length > 0))],
    owner,
  });
  return turn;
}

/**
 * Route a process error only when its stack contains a loaded extension path.
 * Returning false leaves the process owner responsible for the fatal fallback.
 *
 * A detached error carries no session identity, and concurrent sessions usually load
 * the same extension files. When several active turns match, the owner is one of them
 * but nothing says which, so each fails with an error that states the ambiguity. That
 * is narrower than the fatal fallback, which ends every node in the process and leaves
 * the run without an owner.
 */
export function claimPiExtensionProcessError(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false;
  const candidates: [PiExtensionTurn, string, string | undefined][] = [];
  for (const [turn, { extensionPaths, owner }] of activeTurns) {
    const extensionPath = matchingExtensionPath(reason, extensionPaths);
    if (extensionPath) candidates.push([turn, extensionPath, owner]);
  }
  if (candidates.length === 1) {
    const [turn, extensionPath] = candidates[0];
    turn.report(reason, extensionPath);
  } else if (candidates.length > 1) {
    getLog().error(
      {
        err: reason,
        candidates: candidates.map(([, extensionPath, owner]) => ({ owner, extensionPath })),
      },
      'pi.extension_error_ambiguous'
    );
    for (const [turn, extensionPath] of candidates) {
      const ambiguous = new Error(
        `Pi extension '${extensionPath}' failed in a detached callback while ${String(candidates.length)} concurrent Pi turns had it loaded; the failing turn cannot be identified, so each of them fails: ${reason.message}`,
        { cause: reason }
      );
      turn.report(ambiguous, extensionPath, reason.stack ?? reason.message);
    }
  }
  return candidates.length > 0;
}

/** Failure evidence for errors the broker attributed to a Pi extension. */
export function piExtensionFailureEvidence(error: Error): string | undefined {
  return failureEvidence.get(error);
}
