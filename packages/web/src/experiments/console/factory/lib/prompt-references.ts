/**
 * A prompt's `$INPUTS.x` and `$node.output` references as named chips (owner change 7 of
 * 2026-11-21). The server finds them with the engine's grammar and sends each token as written
 * (`FactoryStep['references']`); this module only finds those exact strings again, so it holds
 * no grammar of its own.
 */
import { findAndReplace } from 'mdast-util-find-and-replace';
import type { FactoryWorkflow } from '../../skills/factory';

type StepReference = FactoryWorkflow['steps'][number]['references'][number];

/** An id or name in words: `_` and `-` become spaces. */
const words = (name: string): string => name.replace(/[_-]+/g, ' ').trim();

/**
 * What a chip says: an input by its name in words ("validate command"); a step's output by the
 * step's name, with the field it reads ("Build output, proposed"); last round's by "last
 * round's". `stepName` is `stepLabel` for the step's workflow, so a chip names a step as the
 * rest of the page does.
 */
export function referenceLabel(ref: StepReference, stepName: (key: string) => string): string {
  if (ref.kind === 'input') return words(ref.name);
  const output = `${stepName(ref.key)} output${ref.path === null ? '' : `, ${words(ref.path)}`}`;
  return ref.kind === 'prior-output' ? `last round's ${output}` : output;
}

/** What a chip carries into the rendered markdown, on its `span`'s data attributes. */
export interface ReferenceChip {
  token: string;
  label: string;
  kind: StepReference['kind'];
}

type Tree = Parameters<typeof findAndReplace>[0];

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The node a chip is drawn from: an emphasis node renamed through `data.hName`, a phrasing node
 * mdast knows, drawn as the span the page's markdown components turn into a chip.
 */
function chipNode(chip: ReferenceChip) {
  const data = {
    hName: 'span',
    hProperties: { dataRefLabel: chip.label, dataRefKind: chip.kind, title: chip.token },
  };
  return {
    type: 'emphasis' as const,
    data,
    children: [{ type: 'text' as const, value: chip.label }],
  };
}

/**
 * A code span that is exactly one listed token becomes its chip, in place: the pack writes its
 * inline references in backticks, and the owner ruled (2026-11-22) that such a span is a
 * reference, not code. A span with anything else in it, and a code block, stay code.
 */
function chipWholeTokenSpans(node: Tree, byToken: ReadonlyMap<string, ReferenceChip>): void {
  if (node.type === 'inlineCode') {
    const chip = byToken.get(node.value);
    if (chip !== undefined) {
      Object.assign(node, chipNode(chip));
      Reflect.deleteProperty(node, 'value');
    }
    return;
  }
  if ('children' in node) for (const child of node.children) chipWholeTokenSpans(child, byToken);
}

/**
 * A remark plugin that turns each chip's token, where it stands in prose or as a whole code span,
 * into a `span` the page draws as a chip (`data-ref-label`, `data-ref-kind`, the raw token as its
 * title). A token inside a longer code span or a code block is code, and is left as written.
 * Longer tokens are tried first, so `$build.output.proposed` is never cut to `$build.output`.
 */
export function referenceChips(chips: readonly ReferenceChip[]): () => (tree: Tree) => void {
  const byToken = new Map(chips.map(chip => [chip.token, chip]));
  const tokens = [...byToken.keys()].sort((a, b) => b.length - a.length);
  return () => tree => {
    if (tokens.length === 0) return;
    chipWholeTokenSpans(tree, byToken);
    findAndReplace(tree, [
      [
        new RegExp(tokens.map(escaped).join('|'), 'g'),
        (token: string) => {
          const chip = byToken.get(token);
          return chip === undefined ? false : chipNode(chip);
        },
      ],
    ]);
  };
}
