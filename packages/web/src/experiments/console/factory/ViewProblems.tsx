/**
 * What is wrong with a pack's view file, on the Overview and How it works (DESIGN.md, COMBINED
 * direction: every dropped entry and every in-flow stage, step or outcome without words is a
 * visible warning). One compact line that opens to the list, each entry as `path: message`.
 * Nothing when the file has no problem.
 */
import type { ReactElement } from 'react';
import type { ViewProblem } from './lib/map-source';

/** A problem's place in the file, as the check prints it. */
const where = (problem: ViewProblem): string => problem.path.map(String).join('.') || '(file)';

export function ViewProblems({
  problems,
  drawn,
}: {
  problems: readonly ViewProblem[];
  /** Whether the map is drawn from the file (so it works around the problems). */
  drawn: boolean;
}): ReactElement | null {
  if (problems.length === 0) return null;
  const count = `${String(problems.length)} ${problems.length === 1 ? 'problem' : 'problems'}`;
  return (
    <details data-view-problems className="text-console-12 text-warning">
      <summary className="cursor-pointer select-none">
        {drawn
          ? `The factory view has ${count} the map works around`
          : `The factory view has ${count}`}
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
