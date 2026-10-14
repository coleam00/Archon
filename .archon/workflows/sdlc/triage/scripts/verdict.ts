/**
 * Validate the triage verdict before it routes work, and apply its labels.
 *
 * The prompt judges; the triage node's schema admits only legal decisions (one
 * branch per contract verdict, each carrying only its own fields), so an illegal
 * combination is re-asked at that node rather than refused here. This flattens the
 * decision into the fields every caller reads and checks what a schema cannot:
 * blockers are qualified URLs. The pack's own labels
 * derive from the declared fields here rather than being chosen by the model, and
 * only when the run was launched with publish=true and the target is a tracker
 * issue does this verify the item's identity on the tracker, apply the labels, and
 * read them back. Area labels are never created: the prompt may only pick labels
 * the repository already has. Publishing uses the selected forge source.
 */

import { record, type QualifiedPr } from '../../.shared/forge.ts';
import { emit, refuse, text, trimmed } from '../../.shared/io.ts';
import {
  COMPLEXITY_LABEL,
  type Complexity,
  type Contract,
  isPackLabel,
  PACK_LABEL_NAMES,
  type PackLabel,
  type Route,
  ROUTE_LABEL,
  STATE_LABEL,
  writeLabels,
} from '../../.shared/labels.ts';

type Item = QualifiedPr;
interface Edits {
  readonly title: string;
  readonly body: string;
}

/** A `from:` binding arrives as the producer's JSON, already certified against its schema. */
function bound(value: string | undefined): unknown {
  return JSON.parse(text(value));
}

function isQualifiedUrl(value: string): boolean {
  if (value === '' || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}

/** One branch of the triage decision, as the node's schema admits it. */
type Decision =
  | { contract: 'READY'; route: Exclude<Route, 'continue'> }
  | { contract: 'READY'; route: 'continue'; pull_request: number }
  | { contract: 'NEEDS_CONTRACT_WORK'; proposed_edits: Edits }
  | { contract: 'BLOCKED'; blocked_reason: string; blocked_by: string[] }
  | { contract: 'NO_ACTION' };

function main(): void {
  const decision = bound(process.env.INPUTS_DECISION) as Decision;
  const contract: Contract = decision.contract;
  const route = 'route' in decision ? decision.route : 'no_action';
  const edits: Edits = 'proposed_edits' in decision ? decision.proposed_edits : { title: '', body: '' };
  const blockedReason = 'blocked_reason' in decision ? decision.blocked_reason : '';
  const blockedBy = 'blocked_by' in decision ? decision.blocked_by : [];
  const pullRequest = 'pull_request' in decision ? decision.pull_request : null;
  const complexity = text(process.env.INPUTS_COMPLEXITY) as Complexity;
  const publish = text(process.env.INPUTS_PUBLISH) === 'true';
  const summary = text(process.env.INPUTS_SUMMARY);
  const area = bound(process.env.INPUTS_AREA_LABELS) as string[];
  const boundItem = record(bound(process.env.INPUTS_ITEM));
  const repo = record(boundItem?.repo);
  if (
    typeof repo?.host !== 'string' ||
    typeof repo.path !== 'string' ||
    typeof boundItem?.number !== 'number' ||
    !Number.isInteger(boundItem.number) ||
    !(
      (repo.host === '' && repo.path === '' && boundItem.number === 0) ||
      (repo.host.trim() !== '' && repo.path.trim() !== '' && boundItem.number > 0)
    )
  ) {
    refuse(
      'invalid triage verdict: item requires a qualified repo and positive number, or the empty repo and zero sentinel'
    );
    return;
  }
  const item: Item | undefined =
    boundItem.number === 0
      ? undefined
      : { repo: { host: repo.host, path: repo.path }, number: boundItem.number };
  const report = bound(process.env.INPUTS_REPORT);

  const invalid = (message: string): void => {
    refuse(`invalid triage verdict: ${message}`);
  };

  if (!blockedBy.every(isQualifiedUrl)) {
    invalid('blocked_by must be a list of fully qualified http(s) URLs');
    return;
  }
  if (trimmed(summary) === '') {
    invalid('summary is empty');
    return;
  }
  if (area.some(name => name === '')) {
    invalid('area_labels must be label names');
    return;
  }
  if (area.some(isPackLabel)) {
    // The state and size labels are derived below; a pack label smuggled in as an
    // area label would be added beside the derived state or removed as stale.
    invalid('area_labels may not name a pack label; those derive from the verdict');
    return;
  }

  const wanted: PackLabel[] = [
    decision.contract === 'READY' ? ROUTE_LABEL[decision.route] : STATE_LABEL[decision.contract],
  ];
  // Size only matters on an item that can still be worked; a close verdict carries none.
  if (contract !== 'NO_ACTION') wanted.push(COMPLEXITY_LABEL[complexity]);

  const published = publish && item !== undefined;
  const labels = published
    ? writeLabels(
        item,
        [...wanted, ...area],
        PACK_LABEL_NAMES.filter(name => !wanted.includes(name))
      )
    : [...new Set([...wanted, ...area])].sort();

  emit({
    contract,
    route,
    pull_request: pullRequest,
    ready: contract === 'READY',
    complexity,
    labels,
    published,
    proposed_edits: { title: edits.title, body: edits.body },
    blocked_reason: blockedReason,
    blocked_by: blockedBy,
    summary,
    report,
  });
}

try {
  main();
} catch (error) {
  refuse(`triage labels: ${error instanceof Error ? error.message : String(error)}`);
}
