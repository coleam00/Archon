/**
 * The pack's labels and the one write that applies them.
 *
 * Every label the pack writes is declared here with its color and description,
 * and every stage that writes labels goes through `writeLabels`. Stages are
 * joined by labels, one stage's exit label being the next stage's entry label,
 * so a name declared anywhere else is a copy that can drift.
 */

import { forgeSource, invokeForge, readRepositoryLabels, type QualifiedPr } from './forge.ts';
import { viewIssue } from './issue.ts';

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
  'archon-type-bug': { color: 'D73A4A', description: 'Triage: something that worked is broken' },
  'archon-type-feature': { color: 'A2EEEF', description: 'Triage: new behavior' },
  'archon-type-refactor': { color: 'BFD4F2', description: 'Triage: same behavior, better structure' },
  'archon-type-maintenance': {
    color: 'D4C5F9',
    description: 'Triage: dependencies, tooling, CI, or upkeep',
  },
  'archon-type-docs': { color: '0075CA', description: 'Triage: documentation only' },
  'archon-type-question': { color: 'D876E3', description: 'Triage: a question for a person' },
  'archon-size-s': { color: 'C2E0C6', description: 'Triage: a few files on one surface' },
  'archon-size-m': { color: 'FEF2C0', description: 'Triage: several files or two surfaces' },
  'archon-size-l': { color: 'F9D0C4', description: 'Triage: several packages, schemas, or surfaces' },
  'archon-needs-maintainer': {
    color: 'FBCA04',
    description: 'Intake: an outside item waits for a maintainer to promote it',
  },
  'archon-triage': {
    color: '5319E7',
    description: 'Intake: a request to triage this item; intake removes it when done',
  },
} as const satisfies Record<string, LabelSpec>;

export type PackLabel = keyof typeof PACK_LABELS;

export function isPackLabel(name: string): name is PackLabel {
  return Object.hasOwn(PACK_LABELS, name);
}

// Labels an earlier version of the pack wrote. A write removes them from the item
// and never creates them, so re-triaging an item clears its old size label.
const RETIRED_LABELS = ['archon-small', 'archon-risky', 'archon-large'] as const;

/** A label the pack owns on an item: one it writes now, or one it retired. */
export type OwnedLabel = PackLabel | (typeof RETIRED_LABELS)[number];

export const OWNED_LABEL_NAMES: readonly OwnedLabel[] = [
  ...(Object.keys(PACK_LABELS) as PackLabel[]),
  ...RETIRED_LABELS,
];

export function isOwnedLabel(name: string): name is OwnedLabel {
  return (OWNED_LABEL_NAMES as readonly string[]).includes(name);
}

export type Contract = 'READY' | 'NEEDS_CONTRACT_WORK' | 'BLOCKED' | 'NO_ACTION';
export type WorkType = 'bug' | 'feature' | 'refactor' | 'maintenance' | 'docs' | 'question';
export type Size = 's' | 'm' | 'l';
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
// Of triage's five fields only type and size become labels, the two a person
// filters by; complexity, importance and urgency stay in the verdict.
export const TYPE_LABEL = {
  bug: 'archon-type-bug',
  feature: 'archon-type-feature',
  refactor: 'archon-type-refactor',
  maintenance: 'archon-type-maintenance',
  docs: 'archon-type-docs',
  question: 'archon-type-question',
} as const satisfies Record<WorkType, PackLabel>;
export const SIZE_LABEL = {
  s: 'archon-size-s',
  m: 'archon-size-m',
  l: 'archon-size-l',
} as const satisfies Record<Size, PackLabel>;

/**
 * The labels a person adds to ask intake for something: `archon-triage` asks for
 * triage, and a route label on an outside item promotes it. The pack's own write of
 * a route label is not a request; intake recognizes it as the work item's mirror.
 */
export const REQUEST_LABELS: readonly PackLabel[] = [
  'archon-triage',
  ...new Set(Object.values(ROUTE_LABEL)),
];

export function isRequestLabel(name: string): boolean {
  return (REQUEST_LABELS as readonly string[]).includes(name);
}

/** A triage verdict as far as labels read it: a READY item carries its route. */
export type LabelVerdict =
  | { readonly contract: 'READY'; readonly route: Route }
  | { readonly contract: Exclude<Contract, 'READY'> };

/**
 * The pack labels a verdict derives: one state label and one type label, plus a
 * size label while the item can still be worked; a close verdict carries none.
 */
export function wantedLabels(verdict: LabelVerdict, type: WorkType, size: Size): PackLabel[] {
  const wanted: PackLabel[] = [
    verdict.contract === 'READY' ? ROUTE_LABEL[verdict.route] : STATE_LABEL[verdict.contract],
    TYPE_LABEL[type],
  ];
  if (verdict.contract !== 'NO_ACTION') wanted.push(SIZE_LABEL[size]);
  return wanted;
}

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
  remove: readonly OwnedLabel[]
): string[] {
  return forgeSource() === 'forge' ? forgeWrite(item, add, remove) : ghWrite(item, add, remove);
}

function ghWrite(item: QualifiedPr, add: readonly string[], remove: readonly OwnedLabel[]): string[] {
  const repository = `${item.repo.host}/${item.repo.path}`;
  const current = new Set(viewIssue(item).labels);
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
  const after = new Set(viewIssue(item).labels);
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
  remove: readonly OwnedLabel[]
): string[] {
  const current = viewIssue(item).labels;
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
