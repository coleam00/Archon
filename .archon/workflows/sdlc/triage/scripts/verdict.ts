/**
 * Validate the triage verdict before it routes work, and apply its labels.
 *
 * The prompt judges; this boundary verifies what a schema cannot. Each field's type
 * and vocabulary — the contract, route, and complexity enums, the item and edit
 * shapes, the report pointer — were certified by the engine on the node that
 * produced them, so nothing here re-checks membership. What remains is the relations
 * between fields: only a READY contract carries an engineering route, design-first
 * is a READY item routed to plan, only NEEDS_CONTRACT_WORK proposes edits, only
 * BLOCKED names blockers, and blockers are qualified URLs. The pack's own labels
 * derive from the declared fields here rather than being chosen by the model, and
 * only when the run was launched with publish=true and the target is a tracker
 * issue does this verify the item's identity on the tracker, apply the labels, and
 * read them back. Area labels are never created: the prompt may only pick labels
 * the repository already has. gh is the interim transport; the forge contract's
 * work-item operation is the intended owner.
 */

import { emit, refuse, text, trimmed } from '../../.shared/io.ts';

type Contract = 'READY' | 'NEEDS_CONTRACT_WORK' | 'BLOCKED' | 'NO_ACTION';
type Complexity = 'small' | 'risky' | 'large';

// Exactly one state label per item. Design-first is READY whose next step is
// design, so it replaces the ready label rather than sitting beside it.
const STATE_LABEL: Record<Contract, string> = {
  READY: 'archon-ready',
  NEEDS_CONTRACT_WORK: 'archon-needs-contract',
  BLOCKED: 'archon-blocked',
  NO_ACTION: 'archon-close',
};
const DESIGN_FIRST_LABEL = 'archon-design-first';
const COMPLEXITY_LABEL: Record<Complexity, string> = {
  small: 'archon-small',
  risky: 'archon-risky',
  large: 'archon-large',
};
const PACK_LABELS: Record<string, { color: string; description: string }> = {
  'archon-ready': { color: '0E8A16', description: 'Triage: the contract is ready for a run' },
  'archon-needs-contract': {
    color: 'D93F0B',
    description: "Triage: one of the contract's six elements is missing",
  },
  'archon-blocked': {
    color: 'B60205',
    description: 'Triage: a prerequisite or human decision must land first',
  },
  'archon-close': {
    color: '6A737D',
    description: 'Triage: already delivered, duplicate, obsolete, or out of direction',
  },
  'archon-design-first': {
    color: '5319E7',
    description: 'Triage: ready, but settle the engineering shape before implementing',
  },
  'archon-small': { color: 'C2E0C6', description: 'Triage: bounded change' },
  'archon-risky': {
    color: 'FBCA04',
    description: 'Triage: touches auth, data, a destructive path, or a compatibility boundary',
  },
  'archon-large': {
    color: 'F9D0C4',
    description: 'Triage: several packages or schemas, or an unsettled shape',
  },
};

interface Item {
  readonly repository: string;
  readonly number: number;
}
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

function gh(...args: string[]): string {
  const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

function existingLabels(repository: string): Set<string> {
  const rows = JSON.parse(
    gh('label', 'list', '--repo', repository, '--limit', '500', '--json', 'name')
  ) as { name: string }[];
  return new Set(rows.map(row => row.name));
}

/** The item's current labels, after proving the number names the issue the prompt declared. */
function readIssue(item: Item): Set<string> {
  const issue = JSON.parse(gh('api', `repos/${item.repository}/issues/${String(item.number)}`)) as {
    number?: unknown;
    html_url?: unknown;
    pull_request?: unknown;
    labels?: { name: string }[];
  };
  const url = `https://github.com/${item.repository}/issues/${String(item.number)}`;
  if (
    issue.number !== item.number ||
    (typeof issue.html_url === 'string' ? issue.html_url : '').toLowerCase() !== url.toLowerCase() ||
    'pull_request' in issue
  ) {
    throw new Error(`tracker identity mismatch: ${url} is not the issue the verdict names`);
  }
  return new Set((issue.labels ?? []).map(row => row.name));
}

function apply(item: Item, wanted: string[], area: string[]): string[] {
  const current = readIssue(item);
  const present = existingLabels(item.repository);
  for (const name of wanted) {
    if (!present.has(name)) {
      const { color, description } = PACK_LABELS[name];
      gh('label', 'create', name, '--repo', item.repository, '--color', color, '--description', description);
    }
  }
  const areaPresent = area.filter(name => present.has(name));
  const stale = [...current].filter(name => name in PACK_LABELS && !wanted.includes(name)).sort();
  const toAdd = [...new Set([...wanted, ...areaPresent])].filter(name => !current.has(name)).sort();
  // Narrow add and remove operations, never a whole-set write, so labels an
  // operator adds concurrently survive.
  if (toAdd.length > 0 || stale.length > 0) {
    const args = ['issue', 'edit', String(item.number), '--repo', item.repository];
    for (const name of toAdd) args.push('--add-label', name);
    for (const name of stale) args.push('--remove-label', name);
    gh(...args);
  }
  const after = readIssue(item);
  const missing = [...wanted, ...areaPresent].filter(name => !after.has(name));
  const lingering = stale.filter(name => after.has(name));
  if (missing.length > 0 || lingering.length > 0) {
    throw new Error(
      `label read-back disagrees: missing=${JSON.stringify(missing)} lingering=${JSON.stringify(lingering)}`
    );
  }
  return [...new Set([...wanted, ...areaPresent])].sort();
}

function main(): void {
  const contract = text(process.env.INPUTS_CONTRACT) as Contract;
  const route = text(process.env.INPUTS_ROUTE);
  const complexity = text(process.env.INPUTS_COMPLEXITY) as Complexity;
  const designFirst = text(process.env.INPUTS_DESIGN_FIRST) === 'true';
  const publish = text(process.env.INPUTS_PUBLISH) === 'true';
  const summary = text(process.env.INPUTS_SUMMARY);
  const blockedReason = text(process.env.INPUTS_BLOCKED_REASON);
  const area = bound(process.env.INPUTS_AREA_LABELS) as string[];
  const boundItem = bound(process.env.INPUTS_ITEM) as Item;
  const edits = bound(process.env.INPUTS_PROPOSED_EDITS) as Edits;
  const blockedBy = bound(process.env.INPUTS_BLOCKED_BY) as string[];
  const report = bound(process.env.INPUTS_REPORT);
  // An empty repository is the prompt's spelling for "not a tracker issue".
  const item = boundItem.repository === '' ? undefined : boundItem;

  const invalid = (message: string): void => {
    refuse(`invalid triage verdict: ${message}`);
  };

  if ((contract === 'READY') !== (route !== 'no_action')) {
    invalid(
      `only a READY contract carries an engineering route: got contract=${contract} route=${route}`
    );
    return;
  }
  if (designFirst && route !== 'plan') {
    invalid(`design_first requires route=plan, got route=${route}`);
    return;
  }
  const proposes = edits.title.trim() !== '' && edits.body.trim() !== '';
  if (contract === 'NEEDS_CONTRACT_WORK' && !proposes) {
    invalid('NEEDS_CONTRACT_WORK requires a proposed title and body');
    return;
  }
  if (contract !== 'NEEDS_CONTRACT_WORK' && (edits.title !== '' || edits.body !== '')) {
    invalid('only NEEDS_CONTRACT_WORK proposes edits');
    return;
  }
  if (!blockedBy.every(isQualifiedUrl)) {
    invalid('blocked_by must be a list of fully qualified http(s) URLs');
    return;
  }
  if (contract === 'BLOCKED' && trimmed(blockedReason) === '') {
    invalid('BLOCKED requires a blocked_reason');
    return;
  }
  if (contract !== 'BLOCKED' && (blockedReason !== '' || blockedBy.length > 0)) {
    invalid('only BLOCKED names a blocker');
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
  if (area.some(name => name in PACK_LABELS)) {
    // The state and size labels are derived below; a pack label smuggled in as an
    // area label would be added beside the derived state or removed as stale.
    invalid('area_labels may not name a pack label; those derive from the verdict');
    return;
  }
  if (item !== undefined && (!item.repository.includes('/') || item.number <= 0)) {
    invalid('item must be {repository: owner/repo, number: N} or carry an empty repository');
    return;
  }

  let labels = [designFirst ? DESIGN_FIRST_LABEL : STATE_LABEL[contract]];
  // Size only matters on an item that can still be worked; a close verdict carries none.
  if (contract !== 'NO_ACTION') labels.push(COMPLEXITY_LABEL[complexity]);

  let published = false;
  if (publish && item !== undefined) {
    labels = apply(item, labels, area);
    published = true;
  } else {
    labels = [...new Set([...labels, ...area])].sort();
  }

  emit({
    contract,
    route,
    ready: contract === 'READY',
    design_first: designFirst,
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

main();
