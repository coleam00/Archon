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
  Square,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { ToneColor } from '../tones';

/**
 * Who works a card: its colour along the card's top and its word. A card's `kind` is a slug the
 * pack writes in its `display.phases` and the engine serves as written, so the console's own
 * vocabulary is this map: a kind it does not draw reads as `kindOf`'s neutral one. The colours
 * are the console's node and status tokens, none purple or pink (owner change 1 of
 * 2026-11-19); an agent takes teal.
 */
export const KINDS: Readonly<Record<string, { color: ToneColor; label: string }>> = {
  agent: { color: 'var(--node-wait)', label: 'Agent' },
  check: { color: 'var(--node-loop)', label: 'Check' },
  script: { color: 'var(--node-bash)', label: 'Script' },
  you: { color: 'var(--warning)', label: 'You' },
};

/** Every icon a card may name and the console draws; another reads as `iconOf`'s plain square. */
export const ICONS: Readonly<Record<string, LucideIcon>> = {
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

/** A card kind's colour and word; one the console does not draw is neutral, named as written. */
export function kindOf(kind: string): { color: ToneColor; label: string } {
  return KINDS[kind] ?? { color: 'var(--text-tertiary)', label: kind.replace(/-/g, ' ') };
}

/** A card's icon; one the console does not draw is a plain square. */
export function iconOf(icon: string): LucideIcon {
  return ICONS[icon] ?? Square;
}
