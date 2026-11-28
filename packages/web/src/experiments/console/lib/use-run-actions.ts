import { useState } from 'react';
import * as skill from '../skills';
import { HttpError } from './http';
import { invalidate } from '../store/cache';
import { K } from '../store/keys';
import type { Run } from '../primitives/run';

export type RunAction = 'cancel' | 'resume' | 'abandon';

const CONFIRMATION: Record<Exclude<RunAction, 'resume'>, (run: Run) => string> = {
  cancel: run => `Cancel the running ${run.workflow} run? It stops and cannot be resumed.`,
  abandon: run => `Abandon the ${run.workflow} run? It is cancelled and cannot be resumed.`,
};

/** Cancel and abandon end the run for good, so a stray click must not; resume needs no asking. */
function confirmed(action: RunAction, run: Run): boolean {
  return action === 'resume' || globalThis.confirm(CONFIRMATION[action](run));
}

function actionErrorMessage(error: unknown): string {
  return error instanceof HttpError && error.serverError !== undefined
    ? error.serverError
    : error instanceof Error
      ? error.message
      : 'Action failed.';
}

export interface RunActions {
  busy: RunAction | null;
  error: string | null;
  /**
   * What the server said a resume started. A resumed run that fails again the same way
   * leaves the page unchanged, so the click needs its own acknowledgement.
   */
  notice: string | null;
  /** A cancel the server refused (409): no live owner answered, or it could not be stopped. */
  cancelRefused: boolean;
  call: (action: RunAction) => Promise<void>;
}

/**
 * Cancel, resume and abandon for one run, with the state a surface shows around them.
 * Every surface that offers one of these goes through here, so each asks before ending a
 * run and reports a refusal the same way. Demo runs short-circuit the backend calls.
 */
export function useRunActions(run: Run): RunActions {
  const [busy, setBusy] = useState<RunAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelRefused, setCancelRefused] = useState(false);
  const isDemo = run.id.startsWith('demo-');

  const call = async (action: RunAction): Promise<void> => {
    if (!isDemo && !confirmed(action, run)) return;
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      if (!isDemo) {
        if (action === 'cancel') await skill.cancelRun(run.id);
        if (action === 'resume') setNotice(await skill.resumeRun(run.id));
        if (action === 'abandon') await skill.abandonRun(run.id);
      }
      invalidate('runs');
      invalidate(K.run(run.id));
    } catch (e: unknown) {
      if (action === 'cancel' && e instanceof HttpError && e.status === 409) {
        setCancelRefused(true);
      }
      setError(actionErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return { busy, error, notice, cancelRefused, call };
}
