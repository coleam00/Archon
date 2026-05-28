// Catalogue for the `?` overlay. Keep in sync with each page's useKeymap.
import type { KeymapGroup } from '../components/KeymapHelp';

export const SHORTCUTS: readonly KeymapGroup[] = [
  {
    title: 'Anywhere',
    entries: [
      { keys: ['p'], label: 'Pick a project' },
      { keys: ['n'], label: 'Start a new run' },
      { keys: ['?'], label: 'Show this help' },
    ],
  },
  {
    title: 'Runs feed',
    entries: [
      { keys: ['j'], label: 'Move selection down' },
      { keys: ['k'], label: 'Move selection up' },
      { keys: ['Enter'], label: 'Open selected run' },
      { keys: ['Escape'], label: 'Clear selection' },
      { keys: ['g', 'g'], label: 'Jump to first' },
      { keys: ['G'], label: 'Jump to last' },
      { keys: ['/'], label: 'Focus search' },
      { keys: ['1'], label: 'Filter: running' },
      { keys: ['2'], label: 'Filter: paused' },
      { keys: ['3'], label: 'Filter: failed' },
      { keys: ['4'], label: 'Filter: completed' },
      { keys: ['5'], label: 'Filter: all' },
    ],
  },
  {
    title: 'Run detail',
    entries: [
      { keys: ['1'], label: 'Log tab' },
      { keys: ['2'], label: 'Graph tab' },
      { keys: ['3'], label: 'Artifacts tab' },
      { keys: ['t'], label: 'Toggle tool calls' },
      { keys: ['s'], label: 'Toggle system events' },
      { keys: ['a'], label: 'Approve (paused only)' },
      { keys: ['r'], label: 'Reject (paused only)' },
      { keys: ['Escape'], label: 'Back to runs' },
      { keys: ['h'], label: 'Back to runs' },
    ],
  },
];
