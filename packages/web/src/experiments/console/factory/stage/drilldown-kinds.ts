import {
  CircleAlert,
  ClipboardList,
  Database,
  Flag,
  FlaskConical,
  Gavel,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Inbox,
  Link as LinkIcon,
  MessageSquare,
  MonitorCheck,
  Pencil,
  Ruler,
  Scale,
  Scissors,
  SearchCode,
  Send,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { ToneColor } from '../tones';
import type { CuratedDrilldownCard as DrilldownCard } from '../lib/curated-view';

/**
 * Who works a card: its colour along the card's top and its word. Keyed by the generated kind
 * enum, so a kind the schema gains fails type-check here until it has both. The colours are
 * the console's node and status tokens, none purple or pink (owner change 1 of 2026-11-19);
 * an agent takes the teal How it works gives a stage.
 */
export const KINDS: Record<DrilldownCard['kind'], { color: ToneColor; label: string }> = {
  agent: { color: 'var(--node-wait)', label: 'Agent' },
  check: { color: 'var(--node-loop)', label: 'Check' },
  script: { color: 'var(--node-bash)', label: 'Script' },
  you: { color: 'var(--warning)', label: 'You' },
};

/** Every icon a card may name. Keyed by the generated icon enum, so a new one fails type-check until mapped. */
export const ICONS: Record<DrilldownCard['icon'], LucideIcon> = {
  inbox: Inbox,
  scale: Scale,
  link: LinkIcon,
  ruler: Ruler,
  scissors: Scissors,
  database: Database,
  'clipboard-list': ClipboardList,
  pencil: Pencil,
  wrench: Wrench,
  'git-branch': GitBranch,
  'search-code': SearchCode,
  'flask-conical': FlaskConical,
  'monitor-check': MonitorCheck,
  gavel: Gavel,
  'message-square': MessageSquare,
  'circle-alert': CircleAlert,
  'git-pull-request': GitPullRequest,
  flag: Flag,
  send: Send,
  'shield-check': ShieldCheck,
  'git-merge': GitMerge,
};
