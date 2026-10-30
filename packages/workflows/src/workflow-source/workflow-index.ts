import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { getWorkflowFolderSearchPaths } from '@archon/paths';
import { parseYaml } from '../loader';
import { parseDagNodes } from '../loader/node-parse';
import { walkStaticNodes } from '../include/static-nodes';
import { isWorkflowNode } from '../schemas';
import { isWorkflowFile, isPackWorkflowFile } from '../workflow-discovery/load-dir';
import { BUNDLED_SCOPE_DIR, PROJECT_SCOPE_DIR, isInstalledSourceUnit } from './roots';
import type { SourceUnit } from './unit-index';

const headerSchema = z.object({ name: z.string(), nodes: z.array(z.unknown()) });

function workflowIdentity(content: string): SourceUnit['files'][number]['workflow'] {
  let document: unknown;
  try {
    document = parseYaml(content);
  } catch {
    // Invalid YAML has no selectable identity; full discovery owns its diagnostics.
    return;
  }
  const header = headerSchema.safeParse(document);
  if (!header.success) return;
  const parsed = parseDagNodes(header.data.nodes, header.data.name);
  const references = new Set<string>();
  if (typeof parsed !== 'string') {
    for (const edge of walkStaticNodes(parsed.nodes)) {
      if (edge.kind === 'include') references.add(edge.node.include);
      else if (edge.kind === 'executable' && isWorkflowNode(edge.node))
        references.add(edge.node.workflow);
    }
  }
  return { name: header.data.name, references: [...references] };
}

/** Index staged YAML using discovery's admission rules and the loader's node parser. */
export async function indexWorkflowFiles(root: string, units: SourceUnit[]): Promise<void> {
  for (const unit of units) {
    const paths = new Set(unit.files.map(file => file.path));
    const directories =
      unit.root === PROJECT_SCOPE_DIR ? getWorkflowFolderSearchPaths() : ['workflows'];
    for (const file of unit.files) {
      const admitted = isInstalledSourceUnit(unit.root)
        ? isPackWorkflowFile(file.path)
        : directories.some(directory =>
            isWorkflowFile(
              file.path,
              paths,
              unit.root === BUNDLED_SCOPE_DIR ? `${directory}/defaults` : directory,
              directory
            )
          );
      if (!admitted) continue;
      const identity = workflowIdentity(await readFile(join(root, unit.root, file.path), 'utf-8'));
      if (identity !== undefined) file.workflow = identity;
    }
  }
}
