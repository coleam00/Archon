import type { ReactElement } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Link, type To } from 'react-router';

/**
 * The link a Factory page leads back with, top-left above its content: a chevron and where it
 * goes, in the Meta size, never an underlined accent link.
 */
export function BackLink({ to, label }: { to: To; label: string }): ReactElement {
  return (
    <Link
      to={to}
      data-back-link="true"
      className="inline-flex items-center gap-1 self-start rounded text-console-13 text-text-secondary transition-colors duration-150 ease-out hover:text-text-primary"
    >
      <ChevronLeft aria-hidden="true" className="size-4 shrink-0" />
      {label}
    </Link>
  );
}
