import type { CommandEntry } from '@/lib/api';

export interface CommandCategory {
  name: string;
  commands: CommandEntry[];
}

/** Prefix-to-category mapping. Checked after stripping the `archon-` prefix. */
const CATEGORY_PREFIXES: readonly { category: string; prefixes: string[] }[] = [
  {
    category: 'Investigation',
    prefixes: ['investigate', 'web-research'],
  },
  {
    category: 'Planning',
    prefixes: ['create-plan', 'confirm-plan', 'plan-setup', 'ralph-prd'],
  },
  {
    category: 'Implementation',
    prefixes: ['implement', 'fix-issue', 'implement-tasks', 'implement-issue'],
  },
  {
    category: 'Code Review',
    prefixes: [
      'code-review',
      'error-handling',
      'test-coverage',
      'comment-quality',
      'docs-impact',
      'pr-review-scope',
    ],
  },
  {
    category: 'PR Lifecycle',
    prefixes: ['create-pr', 'finalize-pr', 'post-review', 'sync-pr'],
  },
  {
    category: 'Review Synthesis',
    prefixes: ['synthesize-review', 'implement-review', 'auto-fix', 'self-fix'],
  },
  {
    category: 'Validation',
    prefixes: ['validate'],
  },
];

function stripArchonPrefix(name: string): string {
  return name.startsWith('archon-') ? name.slice('archon-'.length) : name;
}

function findCategory(name: string): string {
  const stripped = stripArchonPrefix(name);
  for (const { category, prefixes } of CATEGORY_PREFIXES) {
    for (const prefix of prefixes) {
      if (stripped === prefix || stripped.startsWith(prefix + '-')) {
        return category;
      }
    }
  }
  return 'Utilities';
}

/**
 * Group commands into named categories.
 * Project commands go first, then named categories in definition order.
 */
export function categorizeCommands(commands: CommandEntry[]): CommandCategory[] {
  const projectCommands = commands.filter(c => c.source === 'project');
  const bundledCommands = commands.filter(c => c.source === 'bundled');

  // Group bundled commands by category
  const categoryMap = new Map<string, CommandEntry[]>();
  for (const cmd of bundledCommands) {
    const category = findCategory(cmd.name);
    const list = categoryMap.get(category);
    if (list) {
      list.push(cmd);
    } else {
      categoryMap.set(category, [cmd]);
    }
  }

  const result: CommandCategory[] = [];

  // Project commands first
  if (projectCommands.length > 0) {
    result.push({ name: 'Project', commands: projectCommands });
  }

  // Named categories in definition order, then Utilities last
  const orderedNames = CATEGORY_PREFIXES.map(c => c.category);
  for (const name of orderedNames) {
    const cmds = categoryMap.get(name);
    if (cmds && cmds.length > 0) {
      result.push({ name, commands: cmds });
    }
  }

  // Utilities last (anything that didn't match a named category)
  const utilities = categoryMap.get('Utilities');
  if (utilities && utilities.length > 0) {
    result.push({ name: 'Utilities', commands: utilities });
  }

  return result;
}
