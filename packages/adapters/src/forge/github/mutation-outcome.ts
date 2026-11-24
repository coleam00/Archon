/** The outcomes a lifecycle mutation reports; `lifecycle.ts` describes when each applies. */

import { z } from 'zod';
import {
  forgeResponseSchema,
  type ForgeSubjectRecord,
  type ForgeLabelRecord,
  mutationTarget,
  mutationAttempt,
  type ForgeCommentRecord,
  type landedSchema,
  type ForgeError,
  type ForgeMutationFailure,
  type ForgeMutationRequest,
  type ForgePrRecord,
  type ForgeResponse,
} from '@archon/forge/operations';
import { githubErrorDetail } from './api';

/** Records how far a mutation's single write got: submitted, then acknowledged by GitHub. */
export type Submit = (phase: 'submitted' | 'acknowledged') => void;

export function failure(
  operationId: string,
  error: ForgeError,
  mutation?: ForgeMutationFailure
): ForgeResponse {
  return mutation ? { operationId, ok: false, error, mutation } : { operationId, ok: false, error };
}

function evidenceBase(
  request: ForgeMutationRequest
): Pick<ForgeMutationFailure, 'op' | 'target' | 'merge' | 'rerun'> {
  return { op: request.op, target: mutationTarget(request), ...mutationAttempt(request) };
}
export function refused(
  request: ForgeMutationRequest,
  error: ForgeError,
  observed?: ForgePrRecord
): ForgeResponse {
  return failure(request.operationId, error, {
    ...evidenceBase(request),
    outcome: 'refused',
    ...(observed ? { observed } : {}),
  });
}
export function unknown(request: ForgeMutationRequest, error: ForgeError): ForgeResponse {
  return failure(request.operationId, error, {
    ...evidenceBase(request),
    outcome: 'outcome_unknown',
  });
}
/** What a read-back saw, attached to a `verification_failed` response. */
type Observed = {
  pr?: ForgePrRecord;
  comment?: ForgeCommentRecord;
  workitem?: ForgeSubjectRecord;
  label?: ForgeLabelRecord;
  landed?: z.infer<typeof landedSchema>;
};

/** The read-back after an acknowledged write could not run: keep its cause behind the context. */
export function readBackFailed(
  request: ForgeMutationRequest,
  context: string,
  cause: unknown,
  leaveBehind: string,
  observed?: Observed
): ForgeResponse {
  const error = githubErrorDetail(cause);
  return unverified(
    request,
    { ...error, message: `${context}: ${error.message}` },
    leaveBehind,
    observed
  );
}

/**
 * A read-back that disagreed is an `invalid_response`; one that could not run passes
 * the forge's own error, so an access failure stays apart from an outage.
 */
export function unverified(
  request: ForgeMutationRequest,
  cause: string | ForgeError,
  leaveBehind: string,
  observed?: Observed
): ForgeResponse {
  return failure(
    request.operationId,
    typeof cause === 'string' ? { kind: 'invalid_response', message: cause } : cause,
    {
      ...evidenceBase(request),
      outcome: 'verification_failed',
      leaveBehind,
      ...(request.op === 'pr.merge' && observed?.landed
        ? {
            merge: {
              method: request.method,
              conditions: request.conditions,
              landed: observed.landed,
            },
          }
        : {}),
      ...(observed?.pr ? { observed: observed.pr } : {}),
      ...(observed?.comment ? { comment: observed.comment } : {}),
      ...(observed?.workitem ? { workitem: observed.workitem } : {}),
      ...(observed?.label ? { label: observed.label } : {}),
    }
  );
}
export function applied(request: ForgeMutationRequest, value: object): ForgeResponse {
  return forgeResponseSchema.parse({
    operationId: request.operationId,
    ok: true,
    result: {
      op: request.op,
      value: { target: mutationTarget(request), outcome: 'applied', ...value },
    },
  });
}
