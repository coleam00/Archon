/** GitHub issue assignees: one user assigned or unassigned, the rest kept. */

import { z } from 'zod';
import type {
  ForgeMutationRequest,
  ForgeResponse,
  ForgeWorkItemRecord,
} from '@archon/forge/operations';
import type { PrRef } from '@archon/forge';
import { GitHubError, githubRequest, location, type Fetch } from './api';
import { applied, refused, unverified, type Submit } from './mutation-outcome';
import { issueSchema, subjectRecord } from './workitems';

// Read only by the assignee writes, so the shared issue shape and its fixtures stay as they are.
const assignedIssueSchema = issueSchema.extend({
  assignees: z.array(z.object({ login: z.string().min(1) })),
});
type AssignedIssue = z.infer<typeof assignedIssueSchema>;
async function readAssigned(fetchImpl: Fetch, token: string, ref: PrRef): Promise<AssignedIssue> {
  const { root, path } = location(ref.repo);
  return assignedIssueSchema.parse(
    await githubRequest(fetchImpl, token, `${root}/repos/${path}/issues/${String(ref.number)}`)
  );
}
function assigneeLogins(item: AssignedIssue): string[] {
  return item.assignees.map(assignee => assignee.login);
}
/** GitHub logins are case-insensitive and read back in the case GitHub registered. */
function isAssigned(item: AssignedIssue, login: string): boolean {
  return item.assignees.some(assignee => assignee.login.toLowerCase() === login.toLowerCase());
}
/** The issue's record; subjectRecord refuses a pull request number before any write. */
function assignedRecord(ref: PrRef, item: AssignedIssue): ForgeWorkItemRecord {
  return { ...subjectRecord({ kind: 'issue', ref }, item), kind: 'issue' };
}

type AssigneeRequest = Extract<
  ForgeMutationRequest,
  { op: 'workitem.assignee.add' | 'workitem.assignee.remove' }
>;

/**
 * One assignee write and what it established, shared by add and remove.
 *
 * GitHub can answer an assignee write with success and leave the user as they were: it
 * ignores either change from a credential without push access, and an add past its limit
 * of ten assignees. A write response that shows the login unchanged is therefore a refusal
 * stating that observation; the response does not say which cause applied. Any other
 * acknowledged write, including one whose response body could not be read, is decided by
 * a separate read of the issue.
 */
async function writeAssignee(
  request: AssigneeRequest,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  const { ref, login } = request;
  const adding = request.op === 'workitem.assignee.add';
  const { root, path } = location(ref.repo);
  submit('submitted');
  let acknowledged = false;
  let written: AssignedIssue | undefined;
  try {
    written = assignedIssueSchema.safeParse(
      await githubRequest(
        fetchImpl,
        token,
        `${root}/repos/${path}/issues/${String(ref.number)}/assignees`,
        { method: adding ? 'POST' : 'DELETE', body: JSON.stringify({ assignees: [login] }) },
        () => {
          acknowledged = true;
          submit('acknowledged');
        }
      )
    ).data;
  } catch (cause) {
    if (!acknowledged) throw cause;
  }
  if (written && isAssigned(written, login) !== adding)
    return refused(request, {
      kind: 'conflict',
      message: adding
        ? `GitHub accepted the request but left ${login} unassigned on issue ${String(ref.number)} in ${ref.repo.path}. GitHub ignores an assignee add from a credential without push access to the repository, and one beyond ten assignees; check which applies.`
        : `GitHub accepted the request but left ${login} assigned on issue ${String(ref.number)} in ${ref.repo.path}. GitHub ignores an assignee removal from a credential without push access to the repository; check the credential's access.`,
    });
  const after = await readAssigned(fetchImpl, token, ref);
  const observed = assignedRecord(ref, after);
  return isAssigned(after, login) === adding
    ? applied(request, { changed: true, workitem: observed, assignees: assigneeLogins(after) })
    : unverified(
        request,
        `Assignee read-back ${adding ? 'did not include the assigned' : 'still included the unassigned'} user`,
        adding ? 'the user may be assigned' : 'the user may have been unassigned',
        { workitem: observed }
      );
}

export async function addAssignee(
  request: Extract<ForgeMutationRequest, { op: 'workitem.assignee.add' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  const { ref, login } = request;
  const before = await readAssigned(fetchImpl, token, ref);
  const workitem = assignedRecord(ref, before);
  if (isAssigned(before, login))
    return applied(request, { changed: false, workitem, assignees: assigneeLogins(before) });
  const { root, path } = location(ref.repo);
  // GitHub accepts an assignee it would not assign and silently drops them, so whether
  // the user can be assigned on this issue is asked first: 204 yes, 404 no. The issue's
  // own check also admits users the repository's does not, such as a commenter.
  try {
    await githubRequest(
      fetchImpl,
      token,
      `${root}/repos/${path}/issues/${String(ref.number)}/assignees/${encodeURIComponent(login)}`,
      {},
      undefined,
      'empty'
    );
  } catch (cause) {
    if (!(cause instanceof GitHubError && cause.detail.status === 404)) throw cause;
    return refused(request, {
      kind: 'not_found',
      message: `GitHub reports ${login} cannot be assigned to issue ${String(ref.number)} in ${ref.repo.path}, and does not say why. Check that the login is spelled right and that the user has access to the repository or has taken part in the issue.`,
    });
  }
  return writeAssignee(request, fetchImpl, token, submit);
}
export async function removeAssignee(
  request: Extract<ForgeMutationRequest, { op: 'workitem.assignee.remove' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  const before = await readAssigned(fetchImpl, token, request.ref);
  const workitem = assignedRecord(request.ref, before);
  if (!isAssigned(before, request.login))
    return applied(request, { changed: false, workitem, assignees: assigneeLogins(before) });
  // GitHub removes only the named logins and keeps the issue's other assignees.
  return writeAssignee(request, fetchImpl, token, submit);
}
