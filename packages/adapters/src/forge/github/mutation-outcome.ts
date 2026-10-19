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
export function unverified(
  request: ForgeMutationRequest,
  message: string,
  leaveBehind: string,
  observed?: {
    pr?: ForgePrRecord;
    comment?: ForgeCommentRecord;
    workitem?: ForgeSubjectRecord;
    label?: ForgeLabelRecord;
    landed?: z.infer<typeof landedSchema>;
  }
): ForgeResponse {
  return failure(
    request.operationId,
    { kind: 'invalid_response', message },
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
