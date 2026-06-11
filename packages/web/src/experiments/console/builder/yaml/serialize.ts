/**
 * Hand-rolled YAML serializer for the live preview pane. Ported from the
 * production `YamlCodeView.tsx` pattern (block scalars for multi-line strings,
 * quoting of ambiguous scalars, two-space list/object indentation) and
 * generalized so every wire key the seven variants emit — including the nested
 * `loop:`/`approval:` objects and `output_format` JSON schemas — serializes
 * without a per-field allowlist.
 *
 * Pure and dependency-free: CodeMirror only *renders* the string; this module
 * *produces* it from `toWorkflowDefinition` output and stays unit-testable
 * without a DOM. Not a general YAML emitter — it covers the value shapes the
 * wire `WorkflowDefinition` can contain (scalars, arrays, plain objects).
 */
import type { WireDagNode, WireWorkflowDefinition } from '../types';

/** Scalars that must be quoted to avoid being re-parsed as a different type. */
function quoteIfAmbiguous(value: string): string {
  if (
    value === '' ||
    value === 'true' ||
    value === 'false' ||
    value === 'null' ||
    /^[\d.]+$/.test(value) ||
    value.includes(':') ||
    value.includes('#') ||
    value.includes('"') ||
    value.includes("'") ||
    value.startsWith('{') ||
    value.startsWith('[') ||
    value.startsWith('&') ||
    value.startsWith('*') ||
    value.startsWith('-') ||
    value !== value.trim()
  ) {
    return JSON.stringify(value);
  }
  return value;
}

/** Serialize one value. `indent` is the column of the key the value follows. */
function serializeValue(value: unknown, indent: number): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    // Multi-line strings use a literal block scalar.
    if (value.includes('\n')) {
      const pad = ' '.repeat(indent + 2);
      return (
        '|\n' +
        value
          .split('\n')
          .map(line => pad + line)
          .join('\n')
      );
    }
    return quoteIfAmbiguous(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const pad = ' '.repeat(indent + 2);
    return '\n' + value.map(v => pad + '- ' + serializeValue(v, indent + 4)).join('\n');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined
    );
    if (entries.length === 0) return '{}';
    const pad = ' '.repeat(indent + 2);
    return '\n' + entries.map(([k, v]) => keyLine(pad, k, v, indent + 2)).join('\n');
  }
  // Unreachable for wire-definition input (all shapes handled above).
  return JSON.stringify(value);
}

/**
 * Render `key: value` after `prefix`, omitting the space when the value
 * renders as an indented block (which begins with its own newline) so no
 * line carries trailing whitespace.
 */
function keyLine(prefix: string, key: string, value: unknown, indent: number): string {
  const rendered = serializeValue(value, indent);
  return rendered.startsWith('\n') ? prefix + key + ':' + rendered : prefix + key + ': ' + rendered;
}

/** Node keys render `id` first, then the author's field order. */
function nodeKeyOrder(node: WireDagNode): string[] {
  const keys = Object.keys(node).filter(k => k !== 'id');
  return ['id', ...keys];
}

/** Serialize one node as a `- ` list item at the given indent. */
function serializeNode(node: WireDagNode, indent: number): string {
  const record = node as Record<string, unknown>;
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  let first = true;
  for (const key of nodeKeyOrder(node)) {
    const value = record[key];
    if (value === undefined) continue;
    const prefix = first ? pad + '- ' : pad + '  ';
    lines.push(keyLine(prefix, key, value, indent + 2));
    first = false;
  }
  return lines.join('\n');
}

/** Convert a wire workflow definition into the YAML preview string. */
export function serializeToYaml(def: WireWorkflowDefinition): string {
  const { name, description, nodes, ...meta } = def;
  const lines: string[] = [];

  lines.push(keyLine('', 'name', name, 0));
  if (description !== undefined && description !== '') {
    lines.push(keyLine('', 'description', description, 0));
  }
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    lines.push(keyLine('', key, value, 0));
  }

  lines.push('');
  lines.push('nodes:');
  for (const node of nodes) {
    lines.push(serializeNode(node, 2));
  }

  return lines.join('\n') + '\n';
}
