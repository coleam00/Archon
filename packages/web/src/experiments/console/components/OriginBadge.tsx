import type { ReactElement } from 'react';
import { Globe, Terminal, Hash, Send, MessageCircle, GitBranch } from 'lucide-react';
import type { RunOrigin } from '../primitives/run';

const ORIGIN_LABEL: Record<RunOrigin, string> = {
  web: 'Web',
  cli: 'CLI',
  slack: 'Slack',
  telegram: 'Telegram',
  discord: 'Discord',
  github: 'GitHub',
  unknown: '—',
};

// One icon per platform so the source is recognisable at a glance. Extends the
// old dashboard's WorkflowRunCard PLATFORM_ICONS (which had 5 entries and fell
// back to a Globe): this covers all 7 RunOrigin values, adding `discord` and
// rendering no icon for `unknown` rather than a misleading default.
const ORIGIN_ICON: Record<RunOrigin, ReactElement | null> = {
  web: <Globe className="h-3 w-3" />,
  cli: <Terminal className="h-3 w-3" />,
  slack: <Hash className="h-3 w-3" />,
  telegram: <Send className="h-3 w-3" />,
  discord: <MessageCircle className="h-3 w-3" />,
  github: <GitBranch className="h-3 w-3" />,
  unknown: null,
};

/** Compact monochrome pill. Never ALL-CAPS, never suffixed. */
export function OriginBadge({ origin }: { origin: RunOrigin }): ReactElement {
  const icon = ORIGIN_ICON[origin];
  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-text-secondary"
      title={`Origin: ${ORIGIN_LABEL[origin]}`}
    >
      {icon}
      {ORIGIN_LABEL[origin]}
    </span>
  );
}
