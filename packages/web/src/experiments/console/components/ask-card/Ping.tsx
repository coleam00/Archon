import type { ReactElement } from 'react';

/** Needs you's ping (rule 7): an 8 px warning dot; under reduced motion only the dot stays. */
export function Ping(): ReactElement {
  return (
    <span data-ping="true" aria-hidden="true" className="relative flex h-2 w-2 shrink-0">
      <span className="absolute inset-0 rounded-full bg-warning motion-safe:animate-ping" />
      <span className="relative h-2 w-2 rounded-full bg-warning" />
    </span>
  );
}
