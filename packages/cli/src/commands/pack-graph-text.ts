/** Lines of `archon pack graph`'s text form: an arrow, and the pack's document with its groups. */
import type { PackGraph, PackGraphLink } from '@archon/workflows/pack-graph';

export function arrowText(arrow: PackGraph['arrows'][number]): string {
  const problems = arrow.active ? arrow.installed.problems : [];
  const state = !arrow.active
    ? 'declared, inactive'
    : problems.length > 0
      ? `active, refused: ${problems.join('; ')}`
      : 'active';
  const declared = arrow.declared?.problems ?? [];
  const note = declared.length > 0 ? ` (binding ${declared.join('; ')})` : '';
  const from =
    'outcome' in arrow.from
      ? `${arrow.from.stage}:${arrow.from.outcome}`
      : `${arrow.from.stage}:asks(${arrow.from.settled}${arrow.from.option === undefined ? '' : `: ${arrow.from.option}`})`;
  return `  ${from} -> ${arrow.to}${arrow.linked ? linkText(arrow.linked) : ''} [${state}]${note}`;
}

/** ` linked <kind> <holder>`, then the items it names and each input read from an entry. */
function linkText(link: PackGraphLink): string {
  const parts = [`linked ${link.kind} ${link.holder}`];
  if (link.items !== undefined) parts.push(`items ${link.items}`);
  for (const [target, pointer] of Object.entries(link.entries))
    parts.push(`${target} from entry ${pointer}`);
  return ` ${parts.join(', ')}`;
}

/** The groups the pack's document declares, and what is wrong with the document. */
export function groupLines(graph: PackGraph): string[] {
  const path = graph.document?.path ?? '';
  const lines: string[] = [];
  if (graph.groups.length > 0) {
    lines.push('', `Groups (${path}):`);
    for (const group of graph.groups) lines.push(`  ${group.name}: ${group.stages.join(', ')}`);
  }
  for (const problem of graph.document?.problems ?? [])
    lines.push('', `Document ${path}: ${problem}`);
  return lines;
}
