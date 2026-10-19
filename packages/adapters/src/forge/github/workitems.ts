/** GitHub work items: reads, listing, creation, labels, body edits and closing. */

import { z } from 'zod';
import {
  contentDigest,
  type ForgeWorkItemRecord,
  type ForgeSubjectRecord,
  type ForgeLabelRecord,
  type ForgeMutationRequest,
  type ForgeRequest,
  type ForgeResponse,
} from '@archon/forge/operations';
import type { ForgeSubjectRef, PrRef, RepoRef } from '@archon/forge';
import { GitHubError, githubPages, githubRequest, location, type Fetch } from './api';
import { authorField, userSchema } from './actor';
import { applied, failure, refused, unverified, type Submit } from './mutation-outcome';

const labelSchema = z.object({
  name: z.string().min(1),
  color: z.string(),
  description: z.string().nullable(),
});
const issueSchema = z.object({
  number: z.number().int().positive(),
  repository_url: z.url(),
  labels: z.array(z.object({ name: z.string().min(1) })),
  html_url: z.url(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  state_reason: z.string().nullable().optional(),
  pull_request: z.unknown().optional(),
  user: userSchema.optional(),
});

type Issue = z.infer<typeof issueSchema>;
/**
 * GitHub's issues endpoint serves pull requests too, and only `pull_request`
 * distinguishes them.
 */
function itemRecord(repo: RepoRef, item: Issue, number = item.number): ForgeSubjectRecord {
  const { root, path } = location(repo);
  if (
    item.number !== number ||
    item.repository_url.toLowerCase() !== `${root}/repos/${path}`.toLowerCase()
  ) {
    throw new GitHubError(
      {
        kind: 'invalid_response',
        message: 'GitHub item read-back did not match the requested identity',
      },
      true
    );
  }
  return {
    ref: { repo, number: item.number },
    kind: item.pull_request === undefined ? 'issue' : 'pr',
    url: item.html_url,
    state: item.state,
  };
}
function issueRecord(repo: RepoRef, item: Issue, number = item.number): ForgeWorkItemRecord {
  const record = itemRecord(repo, item, number);
  if (record.kind !== 'issue')
    throw new GitHubError(
      { kind: 'invalid_response', message: `GitHub item ${String(number)} is not an issue` },
      true
    );
  return { ...record, kind: 'issue' };
}
export function subjectRecord(subject: ForgeSubjectRef, item: Issue): ForgeSubjectRecord {
  const record = itemRecord(subject.ref.repo, item, subject.ref.number);
  if (record.kind !== subject.kind)
    throw new GitHubError(
      {
        kind: 'invalid_request',
        message: `GitHub item ${String(subject.ref.number)} is ${record.kind === 'pr' ? 'a pull request' : 'an issue'}, not ${subject.kind === 'pr' ? 'a pull request' : 'an issue'}`,
      },
      true
    );
  return record;
}
function labelNames(item: Issue): string[] {
  return item.labels.map(label => label.name);
}
export async function readIssue(fetchImpl: Fetch, token: string, ref: PrRef): Promise<Issue> {
  const { root, path } = location(ref.repo);
  return issueSchema.parse(
    await githubRequest(fetchImpl, token, `${root}/repos/${path}/issues/${String(ref.number)}`)
  );
}
function firstLine(body: string | null): string {
  return (body ?? '').split(/\r?\n/, 1)[0];
}
export async function createWorkItem(
  request: Extract<ForgeMutationRequest, { op: 'workitem.create' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  const { root, path } = location(request.repo);
  const issues = await githubPages(
    fetchImpl,
    token,
    `${root}/repos/${path}/issues?state=all`,
    raw => z.array(issueSchema).parse(raw)
  );
  const matches = issues.filter(
    item => item.pull_request === undefined && firstLine(item.body) === request.marker
  );
  if (matches.length > 1)
    return refused(request, {
      kind: 'conflict',
      message: 'Multiple issues carry the canonical marker',
    });
  let number: number;
  const changed = matches.length === 0;
  if (changed) {
    submit('submitted');
    const raw = await githubRequest(
      fetchImpl,
      token,
      `${root}/repos/${path}/issues`,
      {
        method: 'POST',
        body: JSON.stringify({ title: request.title, body: request.body }),
      },
      () => {
        submit('acknowledged');
      }
    );
    number = issueSchema.parse(raw).number;
  } else {
    number = matches[0].number;
  }
  const after = await readIssue(fetchImpl, token, { repo: request.repo, number });
  const workitem = issueRecord(request.repo, after, number);
  if (
    firstLine(after.body) !== request.marker ||
    (changed &&
      (after.title !== request.title || after.body !== request.body || after.state !== 'open'))
  ) {
    return changed
      ? unverified(
          request,
          'Created issue read-back did not match',
          `issue ${String(number)} may exist`,
          { workitem }
        )
      : refused(request, {
          kind: 'conflict',
          message: 'Recovered issue no longer carries the marker',
        });
  }
  return applied(request, {
    changed,
    workitem,
    markerDigest: contentDigest(firstLine(after.body)),
    titleDigest: contentDigest(after.title),
    bodyDigest: contentDigest(after.body ?? ''),
  });
}
async function repositoryLabels(
  fetchImpl: Fetch,
  token: string,
  repo: RepoRef
): Promise<z.infer<typeof labelSchema>[]> {
  const { root, path } = location(repo);
  return githubPages(fetchImpl, token, `${root}/repos/${path}/labels`, raw =>
    z.array(labelSchema).parse(raw)
  );
}
export async function handleGithubRepoLabelsList(
  request: Extract<ForgeRequest, { op: 'repo.labels.list' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const labels = await repositoryLabels(fetchImpl, token, request.repo);
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: request.op,
      value: { repo: request.repo, labels: labels.map(({ name }) => ({ name })) },
    },
  };
}
function labelRecord(label: z.infer<typeof labelSchema>): ForgeLabelRecord {
  return {
    name: label.name,
    color: label.color.toLowerCase(),
    descriptionDigest: contentDigest(label.description ?? ''),
  };
}
export async function ensureLabel(
  request: Extract<ForgeMutationRequest, { op: 'repo.label.ensure' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  const existing = (await repositoryLabels(fetchImpl, token, request.repo)).find(
    label => label.name === request.name
  );
  if (existing) return applied(request, { changed: false, label: labelRecord(existing) });
  const { root, path } = location(request.repo);
  submit('submitted');
  await githubRequest(
    fetchImpl,
    token,
    `${root}/repos/${path}/labels`,
    {
      method: 'POST',
      body: JSON.stringify({
        name: request.name,
        color: request.color,
        description: request.description,
      }),
    },
    () => {
      submit('acknowledged');
    }
  );
  const label = labelRecord(
    labelSchema.parse(
      await githubRequest(
        fetchImpl,
        token,
        `${root}/repos/${path}/labels/${encodeURIComponent(request.name)}`
      )
    )
  );
  if (
    label.name !== request.name ||
    label.color !== request.color ||
    label.descriptionDigest !== contentDigest(request.description)
  )
    return unverified(
      request,
      'Repository label read-back did not match',
      'a repository label may exist',
      { label }
    );
  return applied(request, { changed: true, label });
}
export async function setLabels(
  request: Extract<ForgeMutationRequest, { op: 'workitem.labels.set' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  const before = await readIssue(fetchImpl, token, request.ref);
  const workitem = issueRecord(request.ref.repo, before, request.ref.number);
  const present = await repositoryLabels(fetchImpl, token, request.ref.repo);
  if (request.labels.some(name => !present.some(label => label.name === name)))
    return refused(request, {
      kind: 'not_found',
      message: 'A requested repository label does not exist',
    });
  const equal = (labels: string[]): boolean =>
    labels.length === request.labels.length && request.labels.every(name => labels.includes(name));
  if (equal(before.labels.map(label => label.name)))
    return applied(request, {
      changed: false,
      workitem,
      labels: before.labels.map(label => label.name),
    });
  const { root, path } = location(request.ref.repo);
  submit('submitted');
  await githubRequest(
    fetchImpl,
    token,
    `${root}/repos/${path}/issues/${String(request.ref.number)}/labels`,
    { method: 'PUT', body: JSON.stringify({ labels: request.labels }) },
    () => {
      submit('acknowledged');
    }
  );
  const after = await readIssue(fetchImpl, token, request.ref);
  const observed = issueRecord(request.ref.repo, after, request.ref.number);
  const labels = after.labels.map(label => label.name);
  return equal(labels)
    ? applied(request, { changed: true, workitem: observed, labels })
    : unverified(request, 'Issue label read-back did not match', 'issue labels may have changed', {
        workitem: observed,
      });
}

export async function addLabel(
  request: Extract<ForgeMutationRequest, { op: 'workitem.label.add' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  const { subject, name } = request;
  const before = await readIssue(fetchImpl, token, subject.ref);
  const workitem = subjectRecord(subject, before);
  if (labelNames(before).includes(name))
    return applied(request, { changed: false, workitem, labels: labelNames(before) });
  const { root, path } = location(subject.ref.repo);
  // GitHub creates a label it does not know rather than refusing, and matches
  // names case-insensitively; adding never creates or renames a repository label.
  const label = labelSchema.parse(
    await githubRequest(
      fetchImpl,
      token,
      `${root}/repos/${path}/labels/${encodeURIComponent(name)}`
    )
  );
  if (label.name !== name)
    return refused(request, {
      kind: 'not_found',
      message: 'The requested repository label does not exist',
    });
  submit('submitted');
  await githubRequest(
    fetchImpl,
    token,
    `${root}/repos/${path}/issues/${String(subject.ref.number)}/labels`,
    { method: 'POST', body: JSON.stringify({ labels: [name] }) },
    () => {
      submit('acknowledged');
    }
  );
  const after = await readIssue(fetchImpl, token, subject.ref);
  const observed = subjectRecord(subject, after);
  return labelNames(after).includes(name)
    ? applied(request, { changed: true, workitem: observed, labels: labelNames(after) })
    : unverified(
        request,
        'Label read-back did not include the added label',
        'the label may be on the item',
        { workitem: observed }
      );
}
export async function removeLabel(
  request: Extract<ForgeMutationRequest, { op: 'workitem.label.remove' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  const { subject, name } = request;
  const before = await readIssue(fetchImpl, token, subject.ref);
  const workitem = subjectRecord(subject, before);
  if (!labelNames(before).includes(name))
    return applied(request, { changed: false, workitem, labels: labelNames(before) });
  const { root, path } = location(subject.ref.repo);
  submit('submitted');
  let changed = true;
  try {
    await githubRequest(
      fetchImpl,
      token,
      `${root}/repos/${path}/issues/${String(subject.ref.number)}/labels/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
      () => {
        submit('acknowledged');
      }
    );
  } catch (cause) {
    // A concurrent writer removed the label first. The read-back below decides,
    // and this call changed nothing.
    if (!(cause instanceof GitHubError && cause.detail.status === 404)) throw cause;
    changed = false;
  }
  const after = await readIssue(fetchImpl, token, subject.ref);
  const observed = subjectRecord(subject, after);
  return labelNames(after).includes(name)
    ? unverified(
        request,
        'Label read-back still included the removed label',
        'the label may have been removed',
        { workitem: observed }
      )
    : applied(request, { changed, workitem: observed, labels: labelNames(after) });
}

export async function closeWorkItem(
  request: Extract<ForgeMutationRequest, { op: 'workitem.close' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  const issue = { kind: 'issue', ref: request.ref } as const;
  const before = await readIssue(fetchImpl, token, request.ref);
  const workitem = subjectRecord(issue, before);
  if (before.state === 'closed') {
    // GitHub ignores a new reason on an issue that is already closed.
    return before.state_reason === request.reason
      ? applied(request, { changed: false, workitem, reason: request.reason })
      : refused(request, {
          kind: 'conflict',
          message: `The issue is already closed as ${before.state_reason ?? 'unspecified'}`,
        });
  }
  const { root, path } = location(request.ref.repo);
  submit('submitted');
  await githubRequest(
    fetchImpl,
    token,
    `${root}/repos/${path}/issues/${String(request.ref.number)}`,
    { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: request.reason }) },
    () => {
      submit('acknowledged');
    }
  );
  const after = await readIssue(fetchImpl, token, request.ref);
  const observed = subjectRecord(issue, after);
  return observed.state === 'closed' && after.state_reason === request.reason
    ? applied(request, { changed: true, workitem: observed, reason: request.reason })
    : unverified(request, 'Issue close read-back did not match', 'the issue may be closed', {
        workitem: observed,
      });
}

export async function editWorkItemBody(
  request: Extract<ForgeMutationRequest, { op: 'workitem.edit-body' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  const issue = { kind: 'issue', ref: request.ref } as const;
  const before = await readIssue(fetchImpl, token, request.ref);
  // subjectRecord refuses a pull request number, so the record is an issue's.
  const workitem = { ...subjectRecord(issue, before), kind: 'issue' as const };
  const bodyDigest = contentDigest(request.body);
  if ((before.body ?? '') === request.body)
    return applied(request, { changed: false, workitem, bodyDigest });
  const { root, path } = location(request.ref.repo);
  submit('submitted');
  await githubRequest(
    fetchImpl,
    token,
    `${root}/repos/${path}/issues/${String(request.ref.number)}`,
    { method: 'PATCH', body: JSON.stringify({ body: request.body }) },
    () => {
      submit('acknowledged');
    }
  );
  const leaveBehind = 'the issue body may have changed';
  let after: Issue;
  try {
    after = await readIssue(fetchImpl, token, request.ref);
  } catch {
    return unverified(request, 'Edited issue could not be read back', leaveBehind);
  }
  const observed = issueRecord(request.ref.repo, after, request.ref.number);
  return (after.body ?? '') === request.body
    ? applied(request, { changed: true, workitem: observed, bodyDigest })
    : unverified(request, 'Issue body read-back did not match', leaveBehind, {
        workitem: observed,
      });
}

export async function handleGithubWorkItemView(
  request: Extract<ForgeRequest, { op: 'workitem.view' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const item = await readIssue(fetchImpl, token, request.ref);
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: 'workitem.view',
      value: {
        ...itemRecord(request.ref.repo, item, request.ref.number),
        title: item.title,
        body: item.body ?? '',
        labels: item.labels.map(label => label.name),
        ...authorField(request.ref.repo.host, item.user),
      },
    },
  };
}

export async function handleGithubWorkItemList(
  request: Extract<ForgeRequest, { op: 'workitem.list' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  // GitHub's `labels` filter splits on commas, so such a name cannot be asked for.
  if (request.label.includes(','))
    return failure(request.operationId, {
      kind: 'invalid_request',
      message: 'GitHub cannot list items by a label name that contains a comma',
    });
  const { root, path } = location(request.repo);
  const items = await githubPages(
    fetchImpl,
    token,
    `${root}/repos/${path}/issues?state=open&labels=${encodeURIComponent(request.label)}`,
    raw => z.array(issueSchema).parse(raw)
  );
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: request.op,
      value: {
        repo: request.repo,
        label: request.label,
        // GitHub matches label names case-insensitively; the seam's names are exact.
        items: items
          .filter(item => item.labels.some(label => label.name === request.label))
          .map(item => itemRecord(request.repo, item)),
      },
    },
  };
}
