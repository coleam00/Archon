import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readRunFixture } from './__fixtures__/read-run-fixture';
import { DEFAULT_WORKFLOW_SOURCE_CONFIG } from './workflow-source';
import type { LiveWorkflowSourceRoots } from './workflow-source/roots';
import { factoryViewSchema, type FactoryView } from './schemas/factory-view';
import type { WorkflowEventRow } from './schemas/workflow-event';
import { workflowRunSchema, type WorkflowRun } from './schemas/workflow-run';

/** The pack the fixtures' runs come from. */
export const PACK = 'Wirasm/archon-software-factory';

/** The view file this repository ships for that pack. */
const SHIPPED_VIEW_PATH = join(
  import.meta.dir,
  '../../../.archon/packs/Wirasm.archon-software-factory.factory-view.json'
);

/** The declaration this repository ships for the pack, parsed. */
export function shippedView(): FactoryView {
  return factoryViewSchema.parse(JSON.parse(readFileSync(SHIPPED_VIEW_PATH, 'utf8')));
}

export interface RunFixture {
  run: WorkflowRun;
  events: WorkflowEventRow[];
}

const date = (value: unknown): Date | null =>
  value === null || value === undefined
    ? null
    : value instanceof Date
      ? value
      : new Date(String(value));

/** A run row from its recorded fields, the fields a copy trimmed at their defaults. */
export function hydrateRun(fields: Record<string, unknown>): WorkflowRun {
  return workflowRunSchema.parse({
    origin: null,
    conversation_id: null,
    parent_conversation_id: null,
    codebase_id: null,
    outcome: null,
    completed_outcome: null,
    user_message: '',
    active_phase_started_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
    item_id: null,
    metadata: {},
    ...fields,
    started_at: date(fields.started_at),
    completed_at: date(fields.completed_at),
    last_activity_at: date(fields.last_activity_at),
  });
}

/**
 * Fresh, empty live source roots in a new temp tree `track` removes: a home and, unless
 * `project` is false, a project. Call it in `beforeEach`.
 */
export async function scratchRoots(
  track: (path: string) => string,
  prefix: string,
  { project: withProject = true } = {}
): Promise<{ root: string; project: string; roots: LiveWorkflowSourceRoots }> {
  const root = track(await mkdtemp(join(tmpdir(), prefix)));
  const project = join(root, 'project');
  const roots: LiveWorkflowSourceRoots = {
    kind: 'live',
    config: DEFAULT_WORKFLOW_SOURCE_CONFIG,
    project: withProject ? project : null,
    globalWorkflows: join(root, 'home', 'workflows'),
    globalCommands: join(root, 'home', 'commands'),
    globalScripts: join(root, 'home', 'scripts'),
    bundledWorkflows: join(root, 'bundled'),
    installed: { kind: 'receipts', pluginsDir: join(root, 'home', 'plugins') },
  };
  return { root, project, roots };
}

/** Writes `content` at `path`, its folders made; anything but text is written as JSON. */
export async function writeAt(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
}

/** A run copied from the live factory database: `__fixtures__/<dir>/<name>.jsonl` (its `note` says which). */
export function runFixture(dir: string, name: string): RunFixture {
  const raw = readRunFixture(join(import.meta.dir, '__fixtures__', dir, `${name}.jsonl`));
  return { run: hydrateRun(raw.run), events: raw.events };
}
