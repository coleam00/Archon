/**
 * Validate the triage verdict before it routes work, and apply its labels.
 *
 * The prompt judges; the triage node's schema admits only legal decisions (one
 * branch per contract verdict, each carrying only its own fields), so an illegal
 * combination is re-asked at that node rather than refused here. This flattens the
 * decision into the fields every caller reads and checks what a schema cannot:
 * design-first is a READY item routed to plan, and blockers are qualified URLs. The pack's own labels
 * derive from the declared fields here rather than being chosen by the model, and
 * only when the run was launched with publish=true and the target is a tracker
 * issue does this verify the item's identity on the tracker, apply the labels, and
 * read them back. Area labels are never created: the prompt may only pick labels
 * the repository already has. Publishing uses the selected forge source.
 */

import {
  forgeSource,
  invokeForge,
  readWorkItemLabels,
  readRepositoryLabels,
  record,
  type QualifiedPr,
} from '../../.shared/forge.ts';
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
  const issue = JSON.parse(
    gh('api', '--hostname', item.repo.host, `repos/${item.repo.path}/issues/${String(item.number)}`)
  ) as {
    number?: unknown;
    html_url?: unknown;
    pull_request?: unknown;
    labels?: { name: string }[];
  };
  const url = `https://${item.repo.host}/${item.repo.path}/issues/${String(item.number)}`;
  if (
    issue.number !== item.number ||
    (typeof issue.html_url === 'string' ? issue.html_url : '').toLowerCase() !==
      url.toLowerCase() ||
    'pull_request' in issue
  ) {
    throw new Error(`tracker identity mismatch: ${url} is not the issue the verdict names`);
  }
  return new Set((issue.labels ?? []).map(row => row.name));
}

function apply(item: Item, wanted: string[], area: string[]): string[] {
  if (forgeSource() === 'forge') {
    const current = readWorkItemLabels(item);
    const present = new Set(readRepositoryLabels(item.repo));
    for (const name of wanted) {
      if (!present.has(name))
        invokeForge('repo.label.ensure', { repo: item.repo, name, ...PACK_LABELS[name] });
    }
    const intended = [...new Set([...wanted, ...area.filter(name => present.has(name))])].sort();
    const labels = [
      ...new Set([...current.filter(name => !Object.hasOwn(PACK_LABELS, name)), ...intended]),
    ].sort();
    const result = invokeForge('workitem.labels.set', { ref: item, labels });
    const observedLabels = result?.labels;
    if (
      result?.outcome !== 'applied' ||
      !Array.isArray(observedLabels) ||
      observedLabels.length !== labels.length ||
      !labels.every(name => observedLabels.includes(name))
    )
      throw new Error('forge label-set read-back disagrees');
    return intended;
  }
  const repository = `${item.repo.host}/${item.repo.path}`;
  const current = readIssue(item);
  const present = existingLabels(repository);
  for (const name of wanted) {
    if (!present.has(name)) {
      const { color, description } = PACK_LABELS[name];
      gh(
        'label',
        'create',
        name,
        '--repo',
        repository,
        '--color',
        color,
        '--description',
        description
      );
    }
  }
  const areaPresent = area.filter(name => present.has(name));
  const stale = [...current]
    .filter(name => Object.hasOwn(PACK_LABELS, name) && !wanted.includes(name))
    .sort();
  const toAdd = [...new Set([...wanted, ...areaPresent])].filter(name => !current.has(name)).sort();
  // Narrow add and remove operations, never a whole-set write, so labels an
  // operator adds concurrently survive.
  if (toAdd.length > 0 || stale.length > 0) {
    const args = ['issue', 'edit', String(item.number), '--repo', repository];
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

/** One branch of the triage decision, as the node's schema admits it. */
type Decision =
  | { contract: 'READY'; route: 'investigate' | 'plan' | 'deliver'; design_first: boolean }
  | { contract: 'READY'; route: 'continue'; pull_request: number }
  | { contract: 'NEEDS_CONTRACT_WORK'; proposed_edits: Edits }
  | { contract: 'BLOCKED'; blocked_reason: string; blocked_by: string[] }
  | { contract: 'NO_ACTION' };

function main(): void {
  const decision = bound(process.env.INPUTS_DECISION) as Decision;
  const contract: Contract = decision.contract;
  const route = 'route' in decision ? decision.route : 'no_action';
  const designFirst = 'design_first' in decision && decision.design_first;
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

  if (designFirst && route !== 'plan') {
    invalid(`design_first requires route=plan, got route=${route}`);
    return;
  }
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
  if (area.some(name => Object.hasOwn(PACK_LABELS, name))) {
    // The state and size labels are derived below; a pack label smuggled in as an
    // area label would be added beside the derived state or removed as stale.
    invalid('area_labels may not name a pack label; those derive from the verdict');
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
    pull_request: pullRequest,
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

try {
  main();
} catch (error) {
  refuse(`triage labels: ${error instanceof Error ? error.message : String(error)}`);
}
