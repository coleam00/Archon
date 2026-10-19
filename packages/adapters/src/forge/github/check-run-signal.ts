import {
  listWorkflowEventSignalCandidates,
  signalWorkflowWait,
  type WorkflowEventSignalCandidate,
} from '@archon/core/db/workflows';
import { getLog } from './log';
import type { CheckRunCompletedEvent } from './types';

interface PullRequestIdentity {
  host: string;
  path: string;
  number: number;
}

function readPullRequestIdentity(value: unknown): PullRequestIdentity | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const repo = record.repo;
  if (typeof repo !== 'object' || repo === null || Array.isArray(repo)) return null;
  const repoRecord = repo as Record<string, unknown>;
  if (
    typeof repoRecord.host !== 'string' ||
    repoRecord.host === '' ||
    typeof repoRecord.path !== 'string' ||
    repoRecord.path === '' ||
    typeof record.number !== 'number' ||
    !Number.isInteger(record.number) ||
    record.number <= 0
  ) {
    return null;
  }
  return { host: repoRecord.host, path: repoRecord.path, number: record.number };
}

function candidateMatchesPullRequest(
  candidate: WorkflowEventSignalCandidate,
  pullRequest: PullRequestIdentity,
  completedAt: number
): boolean {
  if (candidate.outputType !== 'pull-request') return false;
  const identity = readPullRequestIdentity(candidate.structuredOutput);
  return (
    identity !== null &&
    identity.host.toLowerCase() === pullRequest.host.toLowerCase() &&
    identity.path.toLowerCase() === pullRequest.path.toLowerCase() &&
    identity.number === pullRequest.number &&
    Date.parse(candidate.wait.waitingSince) <= completedAt
  );
}

/** The one run whose `checks.complete` wait owns this PR, or undefined when none or several do. */
function owningCandidate(
  candidates: readonly WorkflowEventSignalCandidate[],
  pullRequest: PullRequestIdentity,
  completedAt: number
): WorkflowEventSignalCandidate | undefined {
  const matches = new Map<string, WorkflowEventSignalCandidate>();
  for (const candidate of candidates) {
    if (candidateMatchesPullRequest(candidate, pullRequest, completedAt)) {
      matches.set(candidate.runId, candidate);
    }
  }

  if (matches.size > 1) {
    getLog().warn(
      { repo: pullRequest.path, number: pullRequest.number, runIds: [...matches.keys()] },
      'github.check_run_ownership_ambiguous'
    );
    return undefined;
  }
  if (matches.size === 0) {
    getLog().debug(
      { repo: pullRequest.path, number: pullRequest.number },
      'github.check_run_no_owned_wait'
    );
    return undefined;
  }
  return matches.values().next().value;
}

/** Signal each workflow wait that owns one of the completed check run's pull requests. */
export async function signalCheckRunWaits(
  event: CheckRunCompletedEvent,
  host: string
): Promise<void> {
  const completedAt = Date.parse(event.check_run.completed_at);
  const candidates = await listWorkflowEventSignalCandidates('checks.complete', new Date());
  const runSignals = new Map<string, WorkflowEventSignalCandidate>();
  const pullRequestNumbers = [...new Set(event.check_run.pull_requests.map(pr => pr.number))];

  for (const number of pullRequestNumbers) {
    const pullRequest = { host, path: event.repository.full_name, number };
    const match = owningCandidate(candidates, pullRequest, completedAt);
    if (match) runSignals.set(match.runId, match);
  }

  for (const candidate of runSignals.values()) {
    const result = await signalWorkflowWait(candidate.runId, candidate.wait, {
      conclusion: event.check_run.conclusion,
    });
    getLog().info(
      { workflowRunId: candidate.runId, signaled: result.signaled },
      'github.check_run_workflow_signal'
    );
  }
}
