/**
 * Repository-level schema check: every `output_format` a bundled workflow declares
 * must satisfy OpenAI Structured Outputs strict mode.
 *
 * Strict mode has two rules. The Codex provider injects the first one for the author
 * (`additionalProperties: false`, see `normalizeJsonSchemaForOpenAiStrict`). It
 * deliberately does NOT inject the second — every key in `properties` must also
 * appear in `required` — because doing so would silently turn an optional field into
 * a required one and change what the model is asked for (#1843). That leaves the rule
 * with no enforcement anywhere, and a schema that violates it is accepted by every
 * local check and then rejected by the API at the first turn:
 *
 *     invalid_json_schema: 'required' is required to be supplied and to be an array
 *     including every key in properties. Missing 'red_cause'.  (400, run 3bb361e3)
 *
 * That is the bug this file exists to stop repeating. It shipped in #2942: a
 * `red_cause` property was declared optional by omission from `required`, every
 * fixture stayed green — dry runs contact no provider — and every archon-deliver run
 * on a Codex config then died at implement's first turn, before doing any work.
 *
 * The check is on the AUTHORED yaml rather than on a provider payload, because that
 * is where the rule can be satisfied at all: optionality has to be expressed inside
 * the type (an enum carrying the absent form, or a `["string","null"]` union), not by
 * omission from `required`.
 *
 * A workflow that pins `provider:` is exempt. Optional-by-omission is a real engine
 * feature — a declared-optional field that is absent resolves to `''` rather than
 * throwing — and a workflow that names its provider has chosen one that accepts it.
 * A workflow with no pin runs on whatever the operator configured, so it must hold
 * to the strictest provider in the bundle.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');

// join() emits backslashes on Windows; reported paths and the fixture assertion
// below use one spelling so the test means the same thing on every platform (#2954).
function relativePath(file: string): string {
  return file.slice(REPO_ROOT.length + 1).replaceAll('\\', '/');
}
const WORKFLOWS_ROOT = join(REPO_ROOT, '.archon', 'workflows');

interface Violation {
  workflow: string;
  nodeId: string;
  schemaPath: string;
  missing: string[];
}

function yamlFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yamlFilesUnder(path, out);
    else if (path.endsWith('.yaml') || path.endsWith('.yml')) out.push(path);
  }
  return out;
}

/**
 * Every node whose `output_format` this check must inspect: the node itself plus any
 * loop_group body, recursively. A body node declares its own schema and reaches the
 * same provider, so skipping it would leave the deepest schemas unchecked.
 */
function withBodyNodes(node: unknown): unknown[] {
  if (node === null || typeof node !== 'object') return [];
  const body = (node as { loop_group?: { nodes?: unknown[] } }).loop_group?.nodes ?? [];
  return [node, ...body.flatMap(withBodyNodes)];
}

/** Object schema nodes, at any depth, whose `required` omits a declared property. */
function underRequiredNodes(
  schema: unknown,
  path: string,
  out: Omit<Violation, 'workflow' | 'nodeId'>[] = []
) {
  if (schema === null || typeof schema !== 'object') return out;
  if (Array.isArray(schema)) {
    schema.forEach((item, i) => underRequiredNodes(item, `${path}[${i}]`, out));
    return out;
  }
  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    const required = new Set(Array.isArray(record.required) ? (record.required as string[]) : []);
    const missing = Object.keys(properties).filter(key => !required.has(key));
    if (missing.length > 0) out.push({ schemaPath: path, missing });
  }
  for (const [key, value] of Object.entries(record))
    underRequiredNodes(value, `${path}.${key}`, out);
  return out;
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const file of yamlFilesUnder(WORKFLOWS_ROOT)) {
    let doc: unknown;
    try {
      doc = Bun.YAML.parse(require('node:fs').readFileSync(file, 'utf-8'));
    } catch {
      continue; // Not this check's job: the loader owns unparseable workflow files.
    }
    if (doc === null || typeof doc !== 'object') continue;
    const workflow = doc as { nodes?: unknown[]; provider?: unknown };
    if (typeof workflow.provider === 'string') continue; // pinned provider — see the header
    for (const top of workflow.nodes ?? []) {
      for (const node of withBodyNodes(top)) {
        const outputFormat = (node as { output_format?: unknown }).output_format;
        if (outputFormat === undefined) continue;
        const nodeId = String((node as { id?: unknown }).id ?? '(unnamed)');
        for (const found of underRequiredNodes(outputFormat, 'output_format')) {
          violations.push({ workflow: relativePath(file), nodeId, ...found });
        }
      }
    }
  }
  return violations;
}

describe('bundled output_format schemas satisfy OpenAI strict mode (#1843)', () => {
  test('every declared property appears in required, in every unpinned workflow', () => {
    const violations = findViolations().map(
      v =>
        `${v.workflow} › node '${v.nodeId}' › ${v.schemaPath}: ${v.missing.join(', ')} not in required`
    );
    // Listed, not counted: the failure message has to name the schema to fix, because
    // the alternative is a 400 from the provider with only the property name in it.
    expect(violations).toEqual([]);
  });

  test('the check inspects the schemas it claims to, including loop_group bodies', () => {
    // A guard that silently matches nothing passes forever. This pins that the walker
    // actually reaches real schemas — the sdlc pack's gate on implement's verdict is
    // the one whose omission caused #2942 — and that a body node is reachable at all.
    const seen: string[] = [];
    for (const file of yamlFilesUnder(WORKFLOWS_ROOT)) {
      const doc = Bun.YAML.parse(require('node:fs').readFileSync(file, 'utf-8')) as {
        nodes?: unknown[];
      } | null;
      if (doc === null || typeof doc !== 'object') continue;
      for (const top of doc.nodes ?? []) {
        for (const node of withBodyNodes(top)) {
          if ((node as { output_format?: unknown }).output_format !== undefined) {
            seen.push(`${relativePath(file)}:${String((node as { id?: unknown }).id)}`);
          }
        }
      }
    }
    expect(seen).toContain('.archon/workflows/sdlc/implement/archon-implement.yaml:implement');
    expect(seen.length).toBeGreaterThan(10);
  });
});
