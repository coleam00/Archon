import type { ReactElement } from 'react';
import { GitBranch } from 'lucide-react';

/**
 * A forge's icon in the surrounding text colour. The plugin's SVG is only ever a CSS
 * mask over a filled box, so none of its markup or script reaches the document. A forge
 * with no icon gets a generic one.
 */
export function ForgeIcon({
  icon,
  className = 'size-3.5',
}: {
  icon: string | undefined;
  className?: string;
}): ReactElement {
  if (icon === undefined) return <GitBranch aria-hidden className={`shrink-0 ${className}`} />;
  const mask = `url("data:image/svg+xml;base64,${icon}") center / contain no-repeat`;
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 bg-current ${className}`}
      style={{ mask, WebkitMask: mask }}
    />
  );
}
