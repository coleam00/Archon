import { createLogger } from '@archon/paths';
import type { ExtensionError } from '@earendil-works/pi-coding-agent';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.pi.extension-error-broker');
  return cachedLog;
}

class TurnGate {
  private available = true;
  private readonly waiters: (() => void)[] = [];

  acquire(): Promise<void> {
    if (this.available) {
      this.available = false;
      return Promise.resolve();
    }
    return new Promise(resolve => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available = true;
  }
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

interface ActiveTurn {
  readonly extensionPaths: readonly string[];
  readonly turn: PiExtensionTurn;
}

const gate = new TurnGate();
const failureEvidence = new WeakMap<Error, string>();
let activeTurn: ActiveTurn | undefined;

function matchingExtensionPath(
  error: Error,
  extensionPaths: readonly string[]
): string | undefined {
  const stackFrames = error.stack?.split('\n').slice(1);
  if (!stackFrames) return undefined;
  return extensionPaths.find(path => stackFrames.some(frame => frame.includes(path)));
}

/**
 * Start one extension-enabled Pi turn. These turns are process-serialized because
 * two sessions can load the same extension path, making a detached process error
 * impossible to attribute safely while both are active.
 */
export async function beginPiExtensionTurn(
  extensionPaths: readonly string[]
): Promise<PiExtensionTurn> {
  await gate.acquire();

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
      if (activeTurn?.turn === turn) activeTurn = undefined;
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      turn.stopAccepting();
      gate.release();
    },
  };

  activeTurn = {
    extensionPaths: [...new Set(extensionPaths.filter(path => path.length > 0))],
    turn,
  };
  return turn;
}

/**
 * Route a process error only when its stack contains a loaded extension path.
 * Returning false leaves the process owner responsible for the fatal fallback.
 */
export function claimPiExtensionProcessError(reason: unknown): boolean {
  if (!(reason instanceof Error) || !activeTurn) return false;
  const extensionPath = matchingExtensionPath(reason, activeTurn.extensionPaths);
  if (!extensionPath) return false;
  activeTurn.turn.report(reason, extensionPath);
  return true;
}

/** Failure evidence for errors the broker attributed to a Pi extension. */
export function piExtensionFailureEvidence(error: Error): string | undefined {
  return failureEvidence.get(error);
}
