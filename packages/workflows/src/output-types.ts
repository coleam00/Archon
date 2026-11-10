/**
 * `archon workflow types`: the TypeScript a workflow's scripts read its node outputs as,
 * generated from each node's `output_format`. The YAML owns the shape; the generated
 * file is committed, and check mode fails when it no longer matches.
 *
 * It reads workflow files as authored, before include expansion, so a node is emitted
 * once, under the workflow file that declares it, however many workflows include it.
 */
import { mkdir, readFile, realpath, stat, writeFile } from 'fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import * as archonPaths from '@archon/paths';
import type { ProviderRegistry } from '@archon/provider-contract';
import {
  convertOutputSchema,
  indent,
  literal,
  propertyKey,
  quote,
  UnsupportedSchemaError,
  type SchemaLiteral,
} from './output-types/schema-to-ts';
import type { DagNode, IncludeDirective, WorkflowLoadError } from './schemas';
import { isIncludeDirective, isLoopGroupNode, isOutputFormatEnforced, isWaitNode } from './schemas';
import type { WorkflowDefinition } from './schemas/workflow';
import {
  loadPackWorkflows,
  loadWorkflowsFromDir,
  type ParsedWorkflowFile,
  type WorkflowParseContext,
} from './workflow-discovery/load-dir';
import { isYamlFile, readScopePacks } from './workflow-discovery/pack-layout';

/** Where a pack's generated types live, relative to the pack directory. */
export const PACK_OUTPUT_TYPES_FILE = join('.shared', 'outputs.generated.ts');

export interface OutputTypesOptions {
  /** The project whose `.archon/workflows` a name target resolves in. */
  readonly cwd: string;
  /** Where a relative path target and `out` are read from; defaults to `cwd`. */
  readonly targetCwd?: string;
  /** A pack name or directory, a workflow name, or a workflow file or folder path. */
  readonly target: string;
  /** The file to write. Required unless the target is a pack. */
  readonly out?: string;
  /** Compare instead of writing. */
  readonly check: boolean;
  readonly providers: ProviderRegistry;
  /** Names (never values) from the project config's `env:` section. */
  readonly envVarNames?: readonly string[];
}

export interface OutputTypesResult {
  readonly path: string;
  /**
   * `written` and `unchanged` are a generating run's outcomes; `current` and `stale`
   * are a check's. A check reports a missing file as `stale`.
   */
  readonly status: 'written' | 'unchanged' | 'current' | 'stale';
  readonly workflows: number;
  readonly nodes: number;
}

interface NodeTypes {
  readonly id: string;
  readonly type: string;
  readonly enums: ReadonlyMap<string, readonly SchemaLiteral[]>;
}

interface WorkflowTypes {
  readonly name: string;
  readonly nodes: readonly NodeTypes[];
}

interface Selection {
  /** The command that regenerates the file, as its header names it. */
  readonly command: string;
  readonly workflows: readonly WorkflowDefinition[];
  readonly defaultOut?: string;
}

/** One node's type, or the error naming the workflow, the node and the keyword that stops it. */
function nodeTypes(workflowName: string, id: string, schema: unknown): NodeTypes {
  try {
    return { id, ...convertOutputSchema(schema) };
  } catch (error) {
    if (!(error instanceof UnsupportedSchemaError)) throw error;
    throw new Error(
      `Workflow '${workflowName}', node '${id}': output_format ${error.message}. ` +
        'No type is generated for a schema that cannot be stated exactly.',
      { cause: error }
    );
  }
}

/** Whether the author declared this node's output: a wait's schema is the engine's own. */
function declaresOutput(node: DagNode): boolean {
  return node.output_format !== undefined && isOutputFormatEnforced(node) && !isWaitNode(node);
}

/**
 * Every node of `workflow` that declares an enforced `output_format`, in declaration
 * order, loop-group bodies included. An `include:` names nodes another workflow file
 * declares, so it contributes none here.
 */
function declaredOutputs(workflow: WorkflowDefinition): NodeTypes[] {
  const found: NodeTypes[] = [];
  const visit = (nodes: readonly (DagNode | IncludeDirective)[]): void => {
    for (const node of nodes) {
      if (isIncludeDirective(node)) continue;
      if (declaresOutput(node)) {
        if (found.some(other => other.id === node.id)) {
          throw new Error(
            `Workflow '${workflow.name}' declares output_format on two nodes with the id '${node.id}'.`
          );
        }
        found.push(nodeTypes(workflow.name, node.id, node.output_format));
      }
      if (isLoopGroupNode(node)) visit(node.loop_group.nodes);
    }
  };
  visit(workflow.nodes);
  return found;
}

function renderMap(entries: readonly (readonly [string, string])[], separator: string): string {
  const members = entries.map(([key, value]) => `${propertyKey(key)}: ${value}${separator}`);
  return `{\n${indent(members.join('\n'))}\n}`;
}

/** The generated file. Deterministic: workflows by name, nodes and fields in YAML order. */
export function renderOutputTypes(
  command: string,
  workflows: readonly WorkflowDefinition[]
): { content: string; workflows: number; nodes: number } {
  const names = new Set<string>();
  for (const { name } of workflows) {
    if (names.has(name)) throw new Error(`Two workflow files declare the name '${name}'.`);
    names.add(name);
  }
  const typed: WorkflowTypes[] = workflows
    .map(workflow => ({ name: workflow.name, nodes: declaredOutputs(workflow) }))
    .filter(workflow => workflow.nodes.length > 0)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (typed.length === 0) {
    throw new Error('No node declares an output_format, so there is no type to generate.');
  }
  const outputs = renderMap(
    typed.map(({ name, nodes }) => [
      name,
      renderMap(
        nodes.map(node => [node.id, node.type]),
        ';'
      ),
    ]),
    ';'
  );
  const enums = renderMap(
    typed
      .map(({ name, nodes }) => ({ name, nodes: nodes.filter(node => node.enums.size > 0) }))
      .filter(({ nodes }) => nodes.length > 0)
      .map(({ name, nodes }) => [
        name,
        renderMap(
          nodes.map(node => [
            node.id,
            renderMap(
              [...node.enums].map(([path, values]) => [
                path,
                `[${values.map(literal).join(', ')}]`,
              ]),
              ','
            ),
          ]),
          ','
        ),
      ]),
    ','
  );
  const content = `// Generated by \`${command}\` from each node's output_format. Do not edit.
// Change the workflow YAML and rerun the command; with --check it fails while this file is stale.

/** Each workflow's node outputs, as the node's \`output_format\` declares them. */
export interface WorkflowOutputs ${outputs}

/** One node's output, for example \`NodeOutput<${quote(typed[0]?.name ?? '')}, ${quote(typed[0]?.nodes[0]?.id ?? '')}>\`. */
export type NodeOutput<
  W extends keyof WorkflowOutputs,
  N extends keyof WorkflowOutputs[W],
> = WorkflowOutputs[W][N];

/**
 * The values of every \`enum\` in those schemas, by workflow, node and schema path:
 * \`.\` enters a property, \`[]\` an array's items, \`anyOf[n]\` an alternative, and \`$\`
 * is the schema itself.
 */
export const OUTPUT_ENUMS = ${enums} as const;
`;
  return {
    content,
    workflows: typed.length,
    nodes: typed.reduce((count, workflow) => count + workflow.nodes.length, 0),
  };
}

function formatLoadErrors(errors: readonly WorkflowLoadError[]): string {
  return errors.map(error => `  ${error.filename}: ${error.error}`).join('\n');
}

async function existingRealPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** A pack directory's workflows, or undefined when the directory holds no workflow folder. */
async function selectPack(
  context: WorkflowParseContext,
  packPath: string
): Promise<Selection | undefined> {
  const name = basename(packPath);
  const { files, errors } = await loadPackWorkflows(
    { ...context, pack: name, source: 'project', label: name },
    packPath
  );
  if (errors.length > 0) {
    throw new Error(
      `Pack '${name}' has workflows that do not load, so its types would be incomplete:\n${formatLoadErrors(errors)}`
    );
  }
  if (files.length === 0) return undefined;
  return {
    command: `archon workflow types ${name}`,
    workflows: files.map(file => file.parsed.workflow),
    defaultOut: join(packPath, PACK_OUTPUT_TYPES_FILE),
  };
}

/** Every workflow file of the project scope as authored, flat and packaged, with its load errors. */
async function loadProjectWorkflows(
  context: WorkflowParseContext,
  workflowsRoot: string
): Promise<{ parsed: ParsedWorkflowFile[]; errors: WorkflowLoadError[] }> {
  const flat = await loadWorkflowsFromDir(context, workflowsRoot);
  const parsed = [...flat.workflows.values()];
  const scope = await readScopePacks(workflowsRoot);
  const errors = [...flat.errors, ...scope.errors];
  for (const pack of scope.packs) {
    const loaded = await loadPackWorkflows(
      { ...context, pack: pack.name, source: 'project', label: pack.name },
      pack.path
    );
    parsed.push(...loaded.files.map(file => file.parsed));
    errors.push(...loaded.errors);
  }
  return { parsed, errors };
}

/** Whether `targetPath` is the workflow's own file, or the folder that holds it. */
async function isWorkflowPath(entry: ParsedWorkflowFile, targetPath: string): Promise<boolean> {
  if (entry.filePath === undefined) return false;
  const file = await existingRealPath(entry.filePath);
  if (file === undefined) return false;
  return file === targetPath || (!isYamlFile(targetPath) && dirname(file) === targetPath);
}

/** One workflow of the project scope: by name, or by the real path of its file or folder. */
async function selectWorkflow(
  context: WorkflowParseContext,
  workflowsRoot: string,
  target: string,
  targetPath: string | undefined
): Promise<Selection> {
  const { parsed, errors } = await loadProjectWorkflows(context, workflowsRoot);
  const matches: ParsedWorkflowFile[] = [];
  for (const entry of parsed) {
    const matched =
      targetPath === undefined
        ? entry.workflow.name === target
        : await isWorkflowPath(entry, targetPath);
    if (matched) matches.push(entry);
  }
  const [match] = matches;
  if (match === undefined || matches.length > 1) {
    const found =
      match === undefined
        ? `No pack or workflow '${target}' in ${workflowsRoot}.`
        : `'${target}' names ${String(matches.length)} workflows in ${workflowsRoot}; name one file.`;
    const broken =
      errors.length > 0 ? `\nThese workflow files did not load:\n${formatLoadErrors(errors)}` : '';
    throw new Error(`${found}${broken}`);
  }
  return {
    command: `archon workflow types ${match.workflow.name} --out <file>`,
    workflows: [match.workflow],
  };
}

function looksLikePath(target: string): boolean {
  return isAbsolute(target) || target.startsWith('.') || /[\\/]/.test(target);
}

async function select(options: OutputTypesOptions): Promise<Selection> {
  const { cwd, target } = options;
  const [workflowFolder] = archonPaths.getWorkflowFolderSearchPaths();
  if (workflowFolder === undefined) throw new Error('No workflow folder is configured.');
  const workflowsRoot = join(cwd, workflowFolder);
  const context: WorkflowParseContext = {
    providers: options.providers,
    configuredEnvNames: new Set([
      ...archonPaths.getArchonEnvNames(cwd),
      ...(options.envVarNames ?? []),
    ]),
  };
  // A path is read from the invoking directory, then from the project; a bare word is a
  // pack of the project before it is a workflow name.
  let targetPath: string | undefined;
  if (looksLikePath(target)) {
    targetPath =
      (await existingRealPath(resolve(options.targetCwd ?? cwd, target))) ??
      (await existingRealPath(resolve(cwd, target)));
    if (targetPath === undefined) throw new Error(`No file or directory at '${target}'.`);
  }
  const packPath = targetPath ?? (await existingRealPath(join(workflowsRoot, target)));
  if (packPath !== undefined && (await stat(packPath)).isDirectory()) {
    const pack = await selectPack(context, packPath);
    if (pack !== undefined) return pack;
  }
  return await selectWorkflow(context, workflowsRoot, target, targetPath);
}

/** Generate, or with `check` compare, the output types of the pack or workflow `target` names. */
export async function generateOutputTypes(options: OutputTypesOptions): Promise<OutputTypesResult> {
  const selection = await select(options);
  const path =
    options.out !== undefined
      ? resolve(options.targetCwd ?? options.cwd, options.out)
      : selection.defaultOut;
  if (path === undefined) {
    throw new Error(
      `'${options.target}' is one workflow, not a pack, so it has no default file. Pass --out <file>.`
    );
  }
  const rendered = renderOutputTypes(selection.command, selection.workflows);
  const counts = { workflows: rendered.workflows, nodes: rendered.nodes };
  let existing: string | undefined;
  try {
    existing = await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // A checkout that converts line endings, as git does on Windows by default, hands the
  // committed file back with CRLF. The generator writes LF, so compare on LF.
  const same = existing?.replaceAll('\r\n', '\n') === rendered.content;
  if (options.check) return { path, status: same ? 'current' : 'stale', ...counts };
  if (same) return { path, status: 'unchanged', ...counts };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rendered.content);
  return { path, status: 'written', ...counts };
}
