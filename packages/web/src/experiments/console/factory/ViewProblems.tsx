/**
 * What is wrong with a pack's view file (its How it works explainer), and with its document, on
 * the Overview and How it works: every key the file does not have and every stage or edge its
 * picture names that the graph lacks is a visible warning. A stage, step or outcome without
 * words is `archon validate`'s warning, not the file's. One compact line that opens to the
 * list, each view file entry as `path: message`. Nothing when there is no problem.
 */
import type { ReactElement } from 'react';
import type { PackGraph } from '../skills/items';
import type { ViewProblem } from './lib/map-source';
import { documentProblems } from './lib/view-groups';

/** A problem's place in the file, as the check prints it. */
const where = (problem: ViewProblem): string => problem.path.map(String).join('.') || '(file)';

export function ViewProblems({
  problems,
  drawn,
}: {
  problems: readonly ViewProblem[];
  /**
   * Whether the file read, so its How it works explainer draws without the entries listed.
   * Either way the problems are the explainer's to fix: the map is drawn from the pack graph.
   */
  drawn: boolean;
}): ReactElement | null {
  if (problems.length === 0) return null;
  const count = `${String(problems.length)} ${problems.length === 1 ? 'problem' : 'problems'}`;
  return (
    <details data-view-problems className="text-console-12 text-warning">
      <summary className="cursor-pointer select-none">
        {drawn
          ? `The How it works explainer in the pack's view file has ${count} to fix`
          : `The pack's view file has ${count}`}
      </summary>
      <ul className="mt-1 flex flex-col gap-0.5 pl-4 text-text-secondary">
        {problems.map((problem, index) => (
          <li key={`${where(problem)}#${String(index)}`} data-view-problem={problem.kind}>
            <span className="font-mono">{where(problem)}</span>: {problem.message}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * What is wrong with the pack's document and its groups (`documentProblems`), in the same
 * compact line: the groups the map draws are what is left of them. Nothing when there is none.
 */
export function DocumentProblems({
  graph,
}: {
  graph: Pick<PackGraph, 'groups' | 'document'> | undefined;
}): ReactElement | null {
  const problems = documentProblems(graph);
  if (problems.length === 0) return null;
  const count = `${String(problems.length)} ${problems.length === 1 ? 'problem' : 'problems'}`;
  return (
    <details data-document-problems className="text-console-12 text-warning">
      <summary className="cursor-pointer select-none">
        The pack's document ({graph?.document?.path ?? 'its groups'}) has {count}
      </summary>
      <ul className="mt-1 flex flex-col gap-0.5 pl-4 text-text-secondary">
        {problems.map((problem, index) => (
          <li key={`${problem}#${String(index)}`} data-document-problem>
            {problem}
          </li>
        ))}
      </ul>
    </details>
  );
}
