import { stringify, parseDocument, LineCounter, isMap, isSeq, isScalar } from 'yaml';
import { toWorkflowDefinition } from './toWorkflowDefinition';
// IMPORTANT: type-only import to avoid runtime cycle once builder-store.ts
// imports serializeYaml (a value) in Task 7.4.
import type { LoadWorkflowInput } from '../store/builder-store';

export interface NodeRange {
  id: string;
  startLine: number; // 1-based, inclusive
  endLine: number; // 1-based, inclusive
}

export interface SerializeResult {
  yaml: string;
  sourceMap: NodeRange[];
}

const STRINGIFY_OPTIONS = {
  // Match Archon's writer: block style for sequences/maps, no flow.
  lineWidth: 0, // never fold long lines — preserves user intent
} as const;

export function serializeYaml(input: LoadWorkflowInput): SerializeResult {
  const obj = toWorkflowDefinition(input);
  const yaml = stringify(obj, STRINGIFY_OPTIONS);

  const lineCounter = new LineCounter();
  const doc = parseDocument(yaml, { lineCounter });

  const sourceMap: NodeRange[] = [];
  const nodes = doc.get('nodes', true);
  if (isSeq(nodes)) {
    for (const item of nodes.items) {
      if (!isMap(item)) continue;
      const idPair = item.items.find(p => isScalar(p.key) && p.key.value === 'id');
      const idValue = idPair && isScalar(idPair.value) ? String(idPair.value.value) : null;
      if (!idValue) continue;
      const range = item.range; // [start, valueEnd, nodeEnd] byte offsets
      if (!range) continue;
      const start = lineCounter.linePos(range[0]);
      const end = lineCounter.linePos(range[2] ?? range[1]);
      // `end` may point at the start of the *next* line if the node ends with
      // a newline; clamp to the previous non-empty line.
      const endLine = end.col === 1 && end.line > start.line ? end.line - 1 : end.line;
      sourceMap.push({ id: idValue, startLine: start.line, endLine });
    }
  }

  return { yaml, sourceMap };
}
