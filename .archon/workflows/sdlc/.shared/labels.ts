/**
 * The pack's labels and the one write that applies them.
 *
 * Every label the pack writes is declared here with its color and description,
 * and every stage that writes labels goes through `writeLabels`. Stages are
 * joined by labels, one stage's exit label being the next stage's entry label,
 * so a name declared anywhere else is a copy that can drift.
 */

import {
  forgeSource,
  invokeForge,
  readRepositoryLabels,
  readWorkItemLabels,
  type QualifiedPr,
} from './forge.ts';

interface LabelSpec {
  readonly color: string;
  readonly description: string;
}

export const PACK_LABELS = {
  'archon-ready': { color: '0E8A16', description: 'Triage: ready to deliver' },
  'archon-plan': { color: '1D76DB', description: 'Triage: ready; a plan comes before delivery' },
  'archon-issue': {
    color: 'C5DEF5',
    description: 'Triage: ready; an investigation comes before delivery',
  },
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
  'archon-small': { color: 'C2E0C6', description: 'Triage: bounded change' },
  'archon-risky': {
    color: 'FBCA04',
    description: 'Triage: touches auth, data, a destructive path, or a compatibility boundary',
  },
  'archon-large': {
    color: 'F9D0C4',
    description: 'Triage: several packages or schemas, or an unsettled shape',
  },
} as const satisfies Record<string, LabelSpec>;

export type PackLabel = keyof typeof PACK_LABELS;

export const PACK_LABEL_NAMES = Object.keys(PACK_LABELS) as PackLabel[];

export function isPackLabel(name: string): name is PackLabel {
  return Object.hasOwn(PACK_LABELS, name);
}

export type Contract = 'READY' | 'NEEDS_CONTRACT_WORK' | 'BLOCKED' | 'NO_ACTION';
export type Complexity = 'small' | 'risky' | 'large';
export type Route = 'investigate' | 'plan' | 'deliver' | 'continue';

// Exactly one state label per item. A READY item's label names the route the run
// takes on it: archon-ready delivers (a new pull request, or the open one it
// continues), archon-plan plans then delivers, and archon-issue investigates then
// delivers.
export const STATE_LABEL = {
  NEEDS_CONTRACT_WORK: 'archon-needs-contract',
  BLOCKED: 'archon-blocked',
  NO_ACTION: 'archon-close',
} as const satisfies Record<Exclude<Contract, 'READY'>, PackLabel>;
export const ROUTE_LABEL = {
  deliver: 'archon-ready',
  continue: 'archon-ready',
  plan: 'archon-plan',
  investigate: 'archon-issue',
} as const satisfies Record<Route, PackLabel>;
export const COMPLEXITY_LABEL = {
  small: 'archon-small',
  risky: 'archon-risky',
  large: 'archon-large',
} as const satisfies Record<Complexity, PackLabel>;

function gh(...args: string[]): string {
  const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

function ghRepositoryLabels(repository: string): Set<string> {
  const rows = JSON.parse(
    gh('label', 'list', '--repo', repository, '--limit', '500', '--json', 'name')
  ) as { name: string }[];
  return new Set(rows.map(row => row.name));
}

/** The item's current labels, after proving the number names an issue on the tracker. */
function ghIssueLabels(item: QualifiedPr): Set<string> {
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
    throw new Error(`tracker identity mismatch: ${url} does not answer as that issue`);
  }
  return new Set((issue.labels ?? []).map(row => row.name));
}

/**
 * Add and remove labels on an issue as a delta, then read the result back.
 *
 * The issue's identity is verified before anything is written. A missing pack
 * label is created with its declared color and description; any other label is
 * added only when the repository already has it, because the pack never creates
 * a label it does not own. Returns the added labels now on the issue, sorted.
 */
export function writeLabels(
  item: QualifiedPr,
  add: readonly string[],
  remove: readonly PackLabel[]
): string[] {
  return forgeSource() === 'forge' ? forgeWrite(item, add, remove) : ghWrite(item, add, remove);
}

function ghWrite(item: QualifiedPr, add: readonly string[], remove: readonly PackLabel[]): string[] {
  const repository = `${item.repo.host}/${item.repo.path}`;
  const current = ghIssueLabels(item);
  const present = ghRepositoryLabels(repository);
  for (const name of add) {
    if (!present.has(name) && isPackLabel(name)) {
      const { color, description } = PACK_LABELS[name];
      gh('label', 'create', name, '--repo', repository, '--color', color, '--description', description);
      present.add(name);
    }
  }
  const applied = [...new Set(add.filter(name => present.has(name)))].sort();
  const toAdd = applied.filter(name => !current.has(name));
  const removing = new Set<string>(remove);
  const stale = [...current].filter(name => removing.has(name)).sort();
  // Single add and remove operations, never a whole-set write, so labels another
  // writer adds concurrently survive.
  if (toAdd.length > 0 || stale.length > 0) {
    const args = ['issue', 'edit', String(item.number), '--repo', repository];
    for (const name of toAdd) args.push('--add-label', name);
    for (const name of stale) args.push('--remove-label', name);
    gh(...args);
  }
  const after = ghIssueLabels(item);
  const missing = applied.filter(name => !after.has(name));
  const lingering = stale.filter(name => after.has(name));
  if (missing.length > 0 || lingering.length > 0) {
    throw new Error(
      `label read-back disagrees: missing=${JSON.stringify(missing)} lingering=${JSON.stringify(lingering)}`
    );
  }
  return applied;
}

// The forge seam has no single-label add or remove yet, so this reads the item's
// labels and writes the whole set back. A label another writer adds between that
// read and the write is dropped. The race closes when the seam can apply a delta;
// this path then takes the same single add and remove as the gh path.
function forgeWrite(
  item: QualifiedPr,
  add: readonly string[],
  remove: readonly PackLabel[]
): string[] {
  const current = readWorkItemLabels(item);
  const present = new Set(readRepositoryLabels(item.repo));
  for (const name of add) {
    if (!present.has(name) && isPackLabel(name)) {
      invokeForge('repo.label.ensure', { repo: item.repo, name, ...PACK_LABELS[name] });
      present.add(name);
    }
  }
  const applied = [...new Set(add.filter(name => present.has(name)))].sort();
  const removing = new Set<string>(remove);
  const labels = [...new Set([...current.filter(name => !removing.has(name)), ...applied])].sort();
  const result = invokeForge('workitem.labels.set', { ref: item, labels });
  const observedLabels = result?.labels;
  if (
    result?.outcome !== 'applied' ||
    !Array.isArray(observedLabels) ||
    observedLabels.length !== labels.length ||
    !labels.every(name => observedLabels.includes(name))
  )
    throw new Error('forge label-set read-back disagrees');
  return applied;
}
