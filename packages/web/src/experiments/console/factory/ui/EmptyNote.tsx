import type { ReactElement, ReactNode } from 'react';
import { Inbox, type LucideIcon } from 'lucide-react';

/**
 * The Visual standard's empty state (rule 6): a 20 px icon in the tertiary colour, one sentence
 * saying what will appear here, and the most useful link under it when there is one.
 */
export function EmptyNote({
  sentence,
  icon: Icon = Inbox,
  link,
  className = 'flex flex-col items-start gap-2',
}: {
  sentence: ReactNode;
  icon?: LucideIcon;
  link?: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <div className={className}>
      <Icon aria-hidden="true" className="size-5 shrink-0 text-text-tertiary" />
      <p className="min-w-0 text-console-14 text-text-secondary [overflow-wrap:anywhere]">
        {sentence}
      </p>
      {link === undefined ? null : <div className="text-console-13">{link}</div>}
    </div>
  );
}
