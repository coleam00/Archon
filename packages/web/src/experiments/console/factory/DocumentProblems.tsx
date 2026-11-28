/**
 * What is wrong with a pack's document and its groups (`documentProblems`), on the Overview and
 * How it works: one compact line that opens to the list. The groups the map draws are what is
 * left of them. A stage, step or outcome without words is `archon validate`'s warning, not the
 * document's. Nothing when there is no problem.
 */
import type { ReactElement } from 'react';
import type { PackGraph } from '../skills/items';
import { documentProblems } from './lib/view-groups';

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
