/**
 * The issues the build queue worked, and the metric records their outcomes make.
 *
 * The pull-request metrics say what happened to each pull request. These say what
 * happened to each issue, which is what the factory is for, and say it again per route,
 * so a route can be judged by what it costs and what it closes. Every figure is read
 * from the work item; nothing is read from the forge.
 *
 * Each record names its issue as the subject and the build-queue runs that worked it as
 * `runs`, so the engine places it, and its cost, in the cohort of those runs. The engine
 * keeps the latest record per name and subject, so a re-run replaces rather than adds.
 *
 * A metric record has no dimension to split by, so each record is emitted twice: under
 * its name, and under `<name>.<route>` when the issue's route is known.
 */

import { LAUNCH_STAGES } from './build.ts';
import { MAX_RUNS } from './factory-prs.ts';
import type { WorkItem } from './workitem.ts';

export interface IssueMetricRecord {
  readonly name: string;
  readonly kind: 'count' | 'score';
  readonly unit: 'issues' | 'hours' | 'rounds' | 'asks';
  readonly value: number;
  readonly subject: string;
  readonly at: string;
  readonly runs: readonly string[];
}

/**
 * The route the issue entered the build queue on: the one its first recorded round
 * declares. A round recorded before rounds carried their route has none, so the item's
 * intake stage stands in while it is still a route; otherwise the route is unknown and
 * the issue counts only in the totals.
 */
function routeOf(doc: WorkItem): string | null {
  const declared = doc.facts.build?.rounds.find(round => round.route !== undefined)?.route;
  if (declared !== undefined) return declared;
  return (LAUNCH_STAGES as readonly string[]).includes(doc.stage) ? doc.stage : null;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * One issue's records. Built at its first round. Once the merge queue records its pull
 * request merged: merged, the hours from intake's first sight of the issue to that
 * record, the build rounds it took, and the questions a person answered on the way.
 * The work item keeps its last ten rounds and twenty decisions per queue, so an issue
 * past either undercounts.
 */
function outcomes(doc: WorkItem): Omit<IssueMetricRecord, 'subject' | 'runs'>[] {
  const build = doc.facts.build;
  const first = build?.rounds[0];
  if (build === undefined || first === undefined) return [];
  const built = { name: 'sdlc.issues_built', kind: 'count', unit: 'issues', value: 1, at: first.at } as const;
  const merge = doc.facts.merge;
  if (merge?.status !== 'merged') return [built];
  const at = merge.at;
  const asks = [...build.decisions, ...merge.decisions].filter(entry => entry.answer !== undefined).length;
  return [
    built,
    { name: 'sdlc.issues_merged', kind: 'count', unit: 'issues', value: 1, at },
    {
      name: 'sdlc.issue_lead_time',
      kind: 'score',
      unit: 'hours',
      value: (Date.parse(at) - Date.parse(doc.created_at)) / HOUR_MS,
      at,
    },
    { name: 'sdlc.issue_build_rounds', kind: 'score', unit: 'rounds', value: build.rounds.length, at },
    { name: 'sdlc.issue_asks', kind: 'score', unit: 'asks', value: asks, at },
  ];
}

/** Every built issue's outcome records, in total and under its route. */
export function issueMetricRecords(items: readonly WorkItem[]): IssueMetricRecord[] {
  return items.flatMap(doc => {
    const { repo, number } = doc.subject;
    const subject = `${repo.host}/${repo.path}#${String(number)}`;
    const runs = [...new Set((doc.facts.build?.rounds ?? []).map(round => round.run_id))].slice(0, MAX_RUNS);
    const route = routeOf(doc);
    return outcomes(doc).flatMap(outcome => [
      { ...outcome, subject, runs },
      ...(route === null ? [] : [{ ...outcome, name: `${outcome.name}.${route}`, subject, runs }]),
    ]);
  });
}
