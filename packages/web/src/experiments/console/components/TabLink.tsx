import type { ReactElement, ReactNode } from 'react';
import { Link } from 'react-router';

/**
 * One tab of a tab row: the console's project tabs, the Factory sub-navigation and a pack's
 * page tabs. The active tab is marked by the brand-bar underline (the one place the brand
 * gradient is used, Visual standard rule 5) and `aria-current`.
 */
export function TabLink({
  to,
  active,
  children,
}: {
  to: string;
  active: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      className={`relative flex shrink-0 items-center whitespace-nowrap gap-1.5 rounded px-2 py-1 text-console-12 font-medium uppercase tracking-console-label transition-colors duration-150 ease-out ${
        active
          ? 'bg-surface-elevated text-text-primary'
          : 'text-text-tertiary hover:text-text-primary'
      }`}
    >
      {children}
      {active ? (
        <span
          aria-hidden
          data-tab-bar="true"
          className="brand-bar pointer-events-none absolute inset-x-1 -bottom-0.5 h-0.5 rounded-full"
        />
      ) : null}
    </Link>
  );
}
