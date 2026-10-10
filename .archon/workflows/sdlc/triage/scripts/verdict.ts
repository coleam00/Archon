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
 * the repository already has. Publishing uses the selected forge source.
 *
 * The state label is the pack's own by default. A caller that owns its workflow
 * vocabulary passes `state_labels`, a JSON object mapping any of the five states
 * below to its own label names; the mapped label then replaces the pack's, the pack
 * writes no label of its own, and only the mapped labels count as owned when a
 * stale state is removed. A state the caller left unmapped gets no state label.
 * Label names compare case-insensitively, the way the tracker matches them.
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

// The workflow states a caller may map to its own labels. A caller's intake reads
// the same vocabulary, so the two must name the same five states.
type State = 'READY' | 'DESIGN_FIRST' | 'NEEDS_CONTRACT_WORK' | 'BLOCKED' | 'NO_ACTION';
const STATE_LABEL_METADATA: Record<State, { color: string; description: string }> = {
  READY: { color: '0E8A16', description: 'Contract is ready for engineering' },
  DESIGN_FIRST: { color: 'FBCA04', description: 'Engineering shape needs design' },
  NEEDS_CONTRACT_WORK: { color: 'D93F0B', description: 'Contract needs work' },
  BLOCKED: { color: 'B60205', description: 'Unresolved dependency or decision' },
  NO_ACTION: { color: 'CFD3D7', description: 'A human should consider closing' },
};

/** The labels this run may write and the ones it owns, so it may also remove. */
interface Vocabulary {
  /** The state and size labels the verdict derives, before the repository's spelling. */
  readonly derived: string[];
  /** Folded names of every label this vocabulary owns. */
  readonly owned: ReadonlySet<string>;
  /** Color and description for a derived label the repository does not have yet. */
  readonly metadata: (name: string) => { color: string; description: string };
}

const fold = (name: string): string => name.toLowerCase();

/** '' keeps the pack's own labels; a JSON object is the caller's state vocabulary. */
function parseStateLabels(raw: string): Partial<Record<State, string>> | undefined {
  if (raw.trim() === '') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('state_labels must be a JSON object');
  }
  const mapping = record(value);
  if (!mapping || Array.isArray(value)) throw new Error('state_labels must be a JSON object');
  const names: string[] = [];
  for (const [state, name] of Object.entries(mapping)) {
    if (!Object.hasOwn(STATE_LABEL_METADATA, state))
      throw new Error(`state_labels contains an unsupported state: ${state}`);
    if (
      typeof name !== 'string' ||
      name === '' ||
      name.trim() !== name ||
      name.length > 50 ||
      // eslint-disable-next-line no-control-regex -- a label name may not carry a control character
      /[\u0000-\u001f]/.test(name)
    )
      throw new Error('state_labels values must be non-empty label names');
    names.push(fold(name));
  }
  if (new Set(names).size !== names.length)
    throw new Error('state_labels must not map multiple states to the same label');
  return mapping as Partial<Record<State, string>>;
}

function vocabulary(
  mapping: Partial<Record<State, string>> | undefined,
  state: State,
  contract: Contract,
  complexity: Complexity
): Vocabulary {
  if (mapping === undefined) {
    const derived = [state === 'DESIGN_FIRST' ? DESIGN_FIRST_LABEL : STATE_LABEL[contract]];
    // Size only matters on an item that can still be worked; a close verdict carries none.
    if (contract !== 'NO_ACTION') derived.push(COMPLEXITY_LABEL[complexity]);
    return {
      derived,
      owned: new Set(Object.keys(PACK_LABELS).map(fold)),
      metadata: name => PACK_LABELS[name],
    };
  }
  const mapped = mapping[state];
  return {
    derived: mapped === undefined ? [] : [mapped],
    owned: new Set(Object.values(mapping).map(fold)),
    metadata: () => STATE_LABEL_METADATA[state],
  };
}

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

function existingLabels(repository: string): string[] {
  const rows = JSON.parse(
    gh('label', 'list', '--repo', repository, '--limit', '500', '--json', 'name')
  ) as { name: string }[];
  return rows.map(row => row.name);
}

/** The item's current labels, after proving the number names the issue the prompt declared. */
function readIssue(item: Item): string[] {
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
  return (issue.labels ?? []).map(row => row.name);
}

interface Applied {
  /** Every label the item now carries from this verdict, in the repository's spelling. */
  readonly labels: string[];
  /** Proposed area labels the repository does not have, so nothing applied them. */
  readonly skipped: string[];
}

const has = (names: readonly string[], name: string): boolean =>
  names.some(candidate => fold(candidate) === fold(name));

function sortedUnique(names: readonly string[]): string[] {
  const byFold = new Map<string, string>();
  for (const name of names) if (!byFold.has(fold(name))) byFold.set(fold(name), name);
  return [...byFold.values()].sort();
}

/**
 * Resolve the labels to apply against the repository's own: a derived label the
 * repository lacks is created first, an area label it lacks is skipped, and each name
 * takes the repository's spelling, since the tracker matches labels regardless of case.
 */
function resolve(
  present: string[],
  labelsFor: Vocabulary,
  area: string[],
  create: (name: string) => void
): Applied {
  const spelled = (name: string): string | undefined =>
    present.find(candidate => fold(candidate) === fold(name));
  const derived = labelsFor.derived.map(name => {
    const existing = spelled(name);
    if (existing !== undefined) return existing;
    create(name);
    return name;
  });
  const areaPresent = area.map(spelled).filter((name): name is string => name !== undefined);
  return {
    labels: sortedUnique([...derived, ...areaPresent]),
    skipped: area.filter(name => spelled(name) === undefined),
  };
}

function apply(item: Item, labelsFor: Vocabulary, area: string[]): Applied {
  if (forgeSource() === 'forge') {
    const current = readWorkItemLabels(item);
    const intended = resolve(readRepositoryLabels(item.repo), labelsFor, area, name => {
      invokeForge('repo.label.ensure', { repo: item.repo, name, ...labelsFor.metadata(name) });
    });
    const labels = sortedUnique([
      ...current.filter(name => !labelsFor.owned.has(fold(name))),
      ...intended.labels,
    ]);
    const result = invokeForge('workitem.labels.set', { ref: item, labels });
    const observed: unknown = result?.labels;
    if (
      result?.outcome !== 'applied' ||
      !Array.isArray(observed) ||
      observed.length !== labels.length ||
      !labels.every(name => observed.some(seen => typeof seen === 'string' && fold(seen) === fold(name)))
    )
      throw new Error('forge label-set read-back disagrees');
    return intended;
  }
  const repository = `${item.repo.host}/${item.repo.path}`;
  const current = readIssue(item);
  const intended = resolve(existingLabels(repository), labelsFor, area, name => {
    const { color, description } = labelsFor.metadata(name);
    gh('label', 'create', name, '--repo', repository, '--color', color, '--description', description);
  });
  const stale = current
    .filter(name => labelsFor.owned.has(fold(name)) && !has(intended.labels, name))
    .sort();
  const toAdd = intended.labels.filter(name => !has(current, name));
  // Narrow add and remove operations, never a whole-set write, so labels an
  // operator adds concurrently survive.
  if (toAdd.length > 0 || stale.length > 0) {
    const args = ['issue', 'edit', String(item.number), '--repo', repository];
    for (const name of toAdd) args.push('--add-label', name);
    for (const name of stale) args.push('--remove-label', name);
    gh(...args);
  }
  const after = readIssue(item);
  const missing = intended.labels.filter(name => !has(after, name));
  const lingering = stale.filter(name => has(after, name));
  // A label this run does not own must survive it untouched.
  const lost = current.filter(name => !labelsFor.owned.has(fold(name)) && !has(after, name));
  if (missing.length > 0 || lingering.length > 0 || lost.length > 0) {
    throw new Error(
      `label read-back disagrees: missing=${JSON.stringify(missing)} lingering=${JSON.stringify(lingering)} lost=${JSON.stringify(lost)}`
    );
  }
  return intended;
}

function main(): void {
  const contract = text(process.env.INPUTS_CONTRACT) as Contract;
  const route = text(process.env.INPUTS_ROUTE);
  const complexity = text(process.env.INPUTS_COMPLEXITY) as Complexity;
  const designFirst = text(process.env.INPUTS_DESIGN_FIRST) === 'true';
  const publishInput = text(process.env.INPUTS_PUBLISH);
  const stateLabelsInput = text(process.env.INPUTS_STATE_LABELS);
  const summary = text(process.env.INPUTS_SUMMARY);
  const blockedReason = text(process.env.INPUTS_BLOCKED_REASON);
  const area = bound(process.env.INPUTS_AREA_LABELS) as string[];
  const boundItem = record(bound(process.env.INPUTS_ITEM));
  const repo = record(boundItem?.repo);
  // Inputs first: a caller's typo must never read as "stay advisory" or "no mapping".
  if (publishInput !== 'true' && publishInput !== 'false') {
    refuse(`invalid triage input: publish must be true or false, got "${publishInput}"`);
    return;
  }
  const publish = publishInput === 'true';
  let mapping: Partial<Record<State, string>> | undefined;
  try {
    mapping = parseStateLabels(stateLabelsInput);
  } catch (error) {
    refuse(`invalid triage input: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
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
  const edits = bound(process.env.INPUTS_PROPOSED_EDITS) as Edits;
  const blockedBy = bound(process.env.INPUTS_BLOCKED_BY) as string[];
  const report = bound(process.env.INPUTS_REPORT);

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
  if (area.some(name => name.trim() === '')) {
    invalid('area_labels must be label names');
    return;
  }
  if (new Set(area.map(fold)).size !== area.length) {
    // The tracker matches labels regardless of case, so these name one label twice.
    invalid('area_labels must not contain duplicates');
    return;
  }
  const state: State = designFirst ? 'DESIGN_FIRST' : contract;
  const labelsFor = vocabulary(mapping, state, contract, complexity);
  if (
    area.some(name => Object.hasOwn(PACK_LABELS, fold(name)) || labelsFor.owned.has(fold(name)))
  ) {
    // The state and size labels are derived below; a state label smuggled in as an
    // area label would be added beside the derived state or removed as stale.
    invalid(
      'area_labels may not name a pack label or a caller-owned state label; those derive from the verdict'
    );
    return;
  }

  // A wait on open pull requests ends by itself when they merge or close. Publishing
  // the BLOCKED state label would mark the item as touched, and backlog intake would
  // then skip it for good (seen live: an issue blocked on a sibling PR stayed skipped
  // after that PR merged). So such a verdict routes this run but labels nothing, and
  // the next intake re-picks the item once the pull requests are gone.
  const waitsOnPullRequests =
    contract === 'BLOCKED' &&
    blockedBy.length > 0 &&
    blockedBy.every(url => /\/pull\/\d+\/?$/.test(url));

  let labels: string[];
  let skipped: string[] = [];
  let published = false;
  if (publish && item !== undefined && !waitsOnPullRequests) {
    ({ labels, skipped } = apply(item, labelsFor, area));
    published = true;
  } else {
    labels = sortedUnique([...labelsFor.derived, ...area]);
  }

  emit({
    contract,
    route,
    ready: contract === 'READY',
    design_first: designFirst,
    complexity,
    labels,
    published,
    skipped_labels: skipped,
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
