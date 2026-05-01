import { File, Folder, FolderOpen, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/lib/skill-utils';
import type { SkillFileNode } from '@/lib/api';

interface SkillFileTreeProps {
  files: SkillFileNode[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onDelete: (path: string) => void;
}

interface TreeNode {
  name: string;
  fullPath: string;
  isDirectory: boolean;
  size?: number;
  isSymlink?: boolean;
  children: TreeNode[];
}

function buildTree(files: SkillFileNode[]): TreeNode[] {
  const root: TreeNode = {
    name: '',
    fullPath: '',
    isDirectory: true,
    children: [],
  };
  const byPath = new Map<string, TreeNode>();
  byPath.set('', root);

  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const segments = f.path.split('/');
    let parentPath = '';
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      const fullPath = parentPath ? `${parentPath}/${segment}` : segment;
      let node = byPath.get(fullPath);
      if (!node) {
        const isLast = i === segments.length - 1;
        node = {
          name: segment,
          fullPath,
          isDirectory: isLast ? f.isDirectory : true,
          size: isLast ? f.size : undefined,
          isSymlink: isLast ? f.isSymlink : undefined,
          children: [],
        };
        byPath.set(fullPath, node);
        const parent = byPath.get(parentPath);
        if (parent) parent.children.push(node);
      }
      parentPath = fullPath;
    }
  }
  return root.children;
}

export function SkillFileTree({
  files,
  selectedPath,
  onSelect,
  onDelete,
}: SkillFileTreeProps): React.ReactElement {
  const tree = buildTree(files);
  if (tree.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-bridges-border bg-bridges-surface px-4 py-6 text-center text-[12.5px] text-bridges-fg3">
        No supporting files yet. Add a script, reference, or asset to this skill.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border border-bridges-border bg-bridges-surface">
      {tree.map(node => (
        <TreeRow
          key={node.fullPath}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

interface TreeRowProps {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onDelete: (path: string) => void;
}

function TreeRow({
  node,
  depth,
  selectedPath,
  onSelect,
  onDelete,
}: TreeRowProps): React.ReactElement {
  const isSkillMd = node.fullPath === 'SKILL.md';
  const selected = selectedPath === node.fullPath;
  const indent = 8 + depth * 14;
  const iconClassName = 'h-3.5 w-3.5 shrink-0 text-bridges-fg3';

  return (
    <>
      <div
        className={cn(
          'group flex items-center gap-2 border-b border-bridges-border-subtle px-2 py-1.5 text-[12.5px] last:border-b-0 transition-colors',
          selected ? 'bg-bridges-surface-muted' : 'hover:bg-bridges-surface-subtle'
        )}
        style={{ paddingLeft: indent }}
      >
        {node.isDirectory ? (
          depth === 0 ? (
            <FolderOpen className={iconClassName} />
          ) : (
            <Folder className={iconClassName} />
          )
        ) : (
          <File className={iconClassName} />
        )}
        {node.isDirectory ? (
          <span className="flex-1 truncate font-medium text-bridges-fg2">{node.name}/</span>
        ) : (
          <button
            type="button"
            onClick={() => {
              onSelect(node.fullPath);
            }}
            className={cn(
              'flex flex-1 items-center gap-2 truncate text-left text-bridges-fg1',
              isSkillMd && 'font-medium'
            )}
          >
            <span className="truncate">{node.name}</span>
            {node.isSymlink && (
              <span className="rounded bg-bridges-tag-violet-bg px-1 py-px text-[10px] text-bridges-tag-violet-fg">
                link
              </span>
            )}
            {node.size !== undefined && (
              <span className="ml-auto font-mono text-[10.5px] text-bridges-fg3">
                {formatBytes(node.size)}
              </span>
            )}
          </button>
        )}
        {!node.isDirectory && !isSkillMd && (
          <button
            type="button"
            onClick={() => {
              onDelete(node.fullPath);
            }}
            className="opacity-0 transition-opacity group-hover:opacity-100"
            aria-label={`Delete ${node.name}`}
            title="Delete file"
          >
            <Trash2 className="h-3.5 w-3.5 text-bridges-fg3 hover:text-bridges-tint-danger-fg" />
          </button>
        )}
      </div>
      {node.children.map(child => (
        <TreeRow
          key={child.fullPath}
          node={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onDelete={onDelete}
        />
      ))}
    </>
  );
}
