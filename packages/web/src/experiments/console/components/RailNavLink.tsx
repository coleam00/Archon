import type { ReactElement } from 'react';
import type { LucideIcon } from 'lucide-react';
import { NavLink } from 'react-router';

const RAIL_NAV_LINK_CLASS =
  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-console-13 font-medium transition-colors hover:bg-surface-hover hover:text-text-primary';

/** A destination in the console navigation. */
export function RailNavLink({
  to,
  icon: Icon,
  label,
  title,
  badge,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  title?: string;
  /** Optional pill after the label (rail-header "console" pill styling). */
  badge?: string;
}): ReactElement {
  return (
    <NavLink
      to={to}
      title={title}
      className={({ isActive }) =>
        `${RAIL_NAV_LINK_CLASS} ${isActive ? 'bg-surface-elevated text-text-primary' : 'text-text-secondary'}`
      }
    >
      <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{label}</span>
      {badge !== undefined ? (
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-console-10 uppercase tracking-widest text-text-tertiary">
          {badge}
        </span>
      ) : null}
    </NavLink>
  );
}
