/**
 * PURE: assemble the `.archon/marketplace/<slug>/` file map for a workflow —
 * the main YAML plus every referenced `command:` (named command file) and
 * `script:` (named, non-inline script) — so a marketplace install is never
 * missing a file it needs. No I/O beyond reading the referenced files
 * read-only off the local checkout (never mutates the checkout).
 *
 * Bundle layout is flat, one subdir level (mirrors the installer contract —
 * `installDirectory`, `packages/cli/src/commands/workflow.ts:2209-2295`):
 * `.archon/marketplace/<slug>/{<slug>.yaml, commands/<file>, scripts/<file>}`.
 * Skills are NOT bundled (nested skill dirs wouldn't survive the flat install).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import { discoverScripts } from '@archon/workflows/script-discovery';

export interface BundleFile {
  /** Path relative to the repo root, e.g. `.archon/marketplace/<slug>/<slug>.yaml`. */
  repoPath: string;
  content: string;
}

export type BundleErrorReason =
  | 'invalid-slug'
  | 'missing-command-file'
  | 'missing-script-file'
  | 'unsafe-reference';

export class BundleError extends Error {
  readonly reason: BundleErrorReason;
  constructor(reason: BundleErrorReason, message: string) {
    super(message);
    this.name = 'BundleError';
    this.reason = reason;
  }
}

const SLUG_PATTERN = /^[a-z0-9-]+$/;

/** `name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')` (New Files spec) with edge trim. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Mirrors `isInlineScript` (`packages/workflows/src/executor-shared.ts:589-591`) —
 * that module has no exported subpath, so the one-line check is duplicated here
 * rather than adding a new package export surface for a single caller.
 */
function isInlineScript(script: string): boolean {
  return script.includes('\n') || /[;(){}&|<>$`"' ]/.test(script);
}

/** Mirrors `isSafePathComponent` (`packages/cli/src/commands/workflow.ts:2067-2069`). */
function isSafePathComponent(name: string): boolean {
  return name !== '.' && name !== '..' && /^[a-zA-Z0-9._-]+$/.test(name);
}

export interface BundleParams {
  /** Absolute path to the project checkout (the workflow's referenced files live here). */
  cwd: string;
  workflowName: string;
  /** The exact YAML text to ship as `<slug>.yaml` (the source of truth, re-loaded from disk). */
  yamlContent: string;
  workflow: WorkflowDefinition;
}

/** Collect distinct named `command:`/`script:` references across all nodes. */
function collectReferences(workflow: WorkflowDefinition): {
  commands: string[];
  scripts: string[];
} {
  const commands = new Set<string>();
  const scripts = new Set<string>();
  for (const node of workflow.nodes) {
    const command = (node as { command?: unknown }).command;
    if (typeof command === 'string' && command.length > 0) commands.add(command);

    const script = (node as { script?: unknown }).script;
    if (typeof script === 'string' && script.length > 0 && !isInlineScript(script)) {
      scripts.add(script);
    }
  }
  return { commands: [...commands], scripts: [...scripts] };
}

/**
 * Build the marketplace directory bundle for a workflow. Throws `BundleError`
 * on an invalid slug, an unsafe (path-traversal-shaped) reference, or a
 * referenced command/script file that doesn't exist — never ships a broken
 * entry.
 */
export async function buildMarketplaceBundle(params: BundleParams): Promise<BundleFile[]> {
  const slug = slugify(params.workflowName);
  if (!SLUG_PATTERN.test(slug)) {
    throw new BundleError(
      'invalid-slug',
      `Workflow name "${params.workflowName}" produces an invalid slug ("${slug}"). ` +
        'Use a name with at least one lowercase letter, digit, or hyphen.'
    );
  }

  const basePath = `.archon/marketplace/${slug}`;
  const files: BundleFile[] = [
    { repoPath: `${basePath}/${slug}.yaml`, content: params.yamlContent },
  ];

  const { commands, scripts } = collectReferences(params.workflow);

  for (const name of commands) {
    if (!isSafePathComponent(name)) {
      throw new BundleError(
        'unsafe-reference',
        `Command reference "${name}" is not a safe filename (no path separators or "..").`
      );
    }
    const filePath = join(params.cwd, '.archon', 'commands', `${name}.md`);
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      throw new BundleError(
        'missing-command-file',
        `Referenced command file not found: .archon/commands/${name}.md`
      );
    }
    files.push({ repoPath: `${basePath}/commands/${name}.md`, content });
  }

  if (scripts.length > 0) {
    for (const name of scripts) {
      if (!isSafePathComponent(name)) {
        throw new BundleError(
          'unsafe-reference',
          `Script reference "${name}" is not a safe filename (no path separators or "..").`
        );
      }
    }
    const discovered = await discoverScripts(join(params.cwd, '.archon', 'scripts'));
    for (const name of scripts) {
      const def = discovered.get(name);
      if (!def) {
        throw new BundleError(
          'missing-script-file',
          `Referenced script not found: .archon/scripts/${name} (.ts, .js, or .py)`
        );
      }
      const ext = def.path.slice(def.path.lastIndexOf('.'));
      const basename = `${name}${ext}`;
      const content = await readFile(def.path, 'utf-8');
      files.push({ repoPath: `${basePath}/scripts/${basename}`, content });
    }
  }

  return files;
}
