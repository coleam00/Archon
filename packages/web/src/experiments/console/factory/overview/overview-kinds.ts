import {
  Check,
  CircleDot,
  Eye,
  Flag,
  FlaskConical,
  Gavel,
  GitPullRequest,
  Hammer,
  Inbox,
  List,
  Map as MapIcon,
  RotateCcw,
  Scale,
  Search,
  ScrollText,
  Sparkles,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { ToneColor } from '../tones';
import type { OverviewCard } from '../lib/overview-nav';

/**
 * Each card kind's colour and its legend words. Keyed by the generated kind enum, so a kind the
 * schema gains fails type-check here until it has both. The colours are the console's node
 * and status tokens, kept apart by hue so no two kinds read alike, and none
 * purple or pink (DESIGN.md, owner changes of 2026-11-19, points 1 and 6), checked in the
 * browser as the Visual standard says. The check
 * shares the send-back lines' colour, as the live map's check group does (Visual standard rule 5).
 */
export const KINDS: Record<
  OverviewCard['kind'],
  { color: ToneColor; label: string; words: string }
> = {
  input: { color: 'var(--node-command)', label: 'Input', words: 'Where work comes from' },
  stage: { color: 'var(--node-wait)', label: 'Stage', words: 'A stage of the factory' },
  check: { color: 'var(--node-approval)', label: 'Check', words: 'A check on the change' },
  person: { color: 'var(--node-script)', label: 'You', words: 'A person steps in' },
  gate: { color: 'var(--node-bash)', label: 'Gate', words: 'A gate that decides' },
  outcome: { color: 'var(--success)', label: 'Outcome', words: 'What comes out' },
};

/** Every icon a card may name. Keyed by the generated icon enum, so a new one fails type-check until mapped. */
export const ICONS: Record<OverviewCard['icon'], LucideIcon> = {
  inbox: Inbox,
  issue: CircleDot,
  order: ScrollText,
  search: Search,
  scale: Scale,
  map: MapIcon,
  list: List,
  hammer: Hammer,
  'git-pull-request': GitPullRequest,
  check: Check,
  flask: FlaskConical,
  eye: Eye,
  sparkles: Sparkles,
  gavel: Gavel,
  users: Users,
  flag: Flag,
  rotate: RotateCcw,
};
