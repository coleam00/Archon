/**
 * Derive the labels a triage decision puts on its item, and write them when asked.
 * A decision triage could not make, because a forge read failed, refuses here.
 *
 * The pack's own labels derive from the decision here rather than being chosen by the
 * model. Only when the run was launched with publish=true and the target is a tracker
 * issue does this verify the item's identity on the tracker, apply the labels, and
 * read them back; otherwise it records the labels it would apply. Area labels are
 * never created: the prompt may only pick labels the repository already has. Closing
 * the item is not this node's write: archon-intake performs it.
 *
 * Bound inputs: INPUTS_TRIAGE, the triage node's whole output; INPUTS_PUBLISH.
 */

import { emit, refuse, text } from '../../.shared/io.ts';
import { PACK_LABEL_NAMES, requireTriaged, triageLabels, wantedLabels, writeLabels } from '../../.shared/labels.ts';
import type { NodeOutput } from '../../.shared/outputs.generated.ts';

try {
  const output = JSON.parse(text(process.env.INPUTS_TRIAGE)) as NodeOutput<'archon-triage-block', 'triage'>;
  const triage = { ...output, decision: requireTriaged(output.decision) };
  const wanted = wantedLabels(triage.decision, triage.type.value, triage.size.value);
  const labels = triageLabels(triage);
  const published = text(process.env.INPUTS_PUBLISH) === 'true' && triage.item.number !== 0;
  emit({
    labels: published
      ? writeLabels(triage.item, labels, PACK_LABEL_NAMES.filter(name => !wanted.some(label => label === name)))
      : labels,
    published,
  });
} catch (error) {
  refuse(`triage labels: ${error instanceof Error ? error.message : String(error)}`);
}
