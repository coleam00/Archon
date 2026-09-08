import { triggerEventSchema, type TriggerEvent } from '@archon/workflows/trigger';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Extract qualified facts only. Bodies, workflow names and commands never cross. */
export function parseGitHubIssueTrigger(
  payload: unknown,
  deliveryId: string | undefined
): TriggerEvent | null {
  const event = record(payload);
  if (!event || (event.action !== 'opened' && event.action !== 'labeled')) return null;
  const issue = record(event.issue);
  const repository = record(event.repository);
  const sender = record(event.sender);
  if (
    !issue ||
    !repository ||
    !sender ||
    issue.pull_request !== undefined ||
    event.pull_request !== undefined
  )
    throw new Error('Malformed issue trigger payload');
  const owner = record(repository.owner);
  if (repository.full_name !== `${String(owner?.login)}/${String(repository.name)}`)
    throw new Error('Inconsistent issue repository identity');
  if (issue.state !== 'open') throw new Error('Issue trigger requires an open issue');
  return triggerEventSchema.parse({
    kind: 'github.issue',
    eventId: deliveryId,
    repository: repository.full_name,
    actor: sender.login,
    action: event.action,
    issueNumber: issue.number,
    ...(event.action === 'labeled' ? { label: record(event.label)?.name } : {}),
  });
}
