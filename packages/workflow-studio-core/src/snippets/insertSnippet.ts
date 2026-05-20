import { fromWorkflowDefinition } from '../exporter/fromWorkflowDefinition';
import { layoutWithDagre } from '../hooks/useDagre';
import { useBuilderStore } from '../store/builder-store';
import { makeUniqueId } from '../nodes/shared/makeUniqueId';
import { renameSubgraph } from './renameSubgraph';
import { parse as parseYaml } from 'yaml';

export interface InsertSnippetOptions {
  yaml: string;
  anchorPosition: { x: number; y: number };
  setPosition: (id: string, position: { x: number; y: number }) => void;
}

export interface InsertSnippetResult {
  insertedIds: string[];
}

export function insertSnippet({
  yaml,
  anchorPosition,
  setPosition,
}: InsertSnippetOptions): InsertSnippetResult {
  const definition = parseYaml(yaml);
  const { nodes: snippetNodes } = fromWorkflowDefinition(definition);

  const existingIds = new Set(useBuilderStore.getState().nodes.map(n => n.id));
  const idMap = new Map<string, string>();
  for (const n of snippetNodes) {
    const newId = makeUniqueId(n.id, existingIds);
    if (newId !== n.id) idMap.set(n.id, newId);
    existingIds.add(newId); // keep collisions disjoint within the snippet itself
  }

  const renamed = renameSubgraph(snippetNodes, idMap);

  const renamedIds = new Set(renamed.map(n => n.id));
  const layoutNodes = renamed.map(n => ({ id: n.id, position: { x: 0, y: 0 } }));
  const layoutEdges = renamed.flatMap(n => {
    const dep = (n.base.depends_on as string[] | undefined) ?? [];
    return dep
      .filter(src => renamedIds.has(src))
      .map(src => ({ id: `${src}->${n.id}`, source: src, target: n.id }));
  });
  const layout = layoutWithDagre(layoutNodes, layoutEdges);

  let cx = 0,
    cy = 0,
    count = 0;
  for (const pos of layout.values()) {
    cx += pos.x;
    cy += pos.y;
    count += 1;
  }
  if (count > 0) {
    cx /= count;
    cy /= count;
  }

  const dx = anchorPosition.x - cx;
  const dy = anchorPosition.y - cy;

  const insertedIds: string[] = [];
  const addNode = useBuilderStore.getState().addNode;
  for (const n of renamed) {
    addNode(n);
    insertedIds.push(n.id);
    const local = layout.get(n.id) ?? { x: 0, y: 0 };
    setPosition(n.id, { x: local.x + dx, y: local.y + dy });
  }
  return { insertedIds };
}
