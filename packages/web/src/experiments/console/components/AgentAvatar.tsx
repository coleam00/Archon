import { useId, type ReactElement } from 'react';

interface AgentAvatarProps {
  size?: number;
}

/**
 * 30px gradient-ring avatar for assistant messages. Mirrors the design
 * handoff's `chat-icons.jsx:23-41` shape. SVG `linearGradient` cannot read
 * CSS custom props reliably, so brand stops are hard-coded — same trade-off
 * the handoff takes.
 *
 * Inner fill references `--surface-elevated` so the punched-hole effect
 * tracks any future surface-token rebalance (handoff's `#15171d` resolves
 * to the same family).
 */
export function AgentAvatar({ size = 30 }: AgentAvatarProps): ReactElement {
  const gid = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <defs>
        <linearGradient id={gid} x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ED10EC" />
          <stop offset="0.5" stopColor="#8E40C8" />
          <stop offset="1" stopColor="#06CE94" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="15" stroke={`url(#${gid})`} strokeWidth="1.6" />
      <circle cx="16" cy="16" r="11.5" fill="var(--surface-elevated)" />
      <path
        d="M16 8.5l6 10.6H10L16 8.5z"
        stroke={`url(#${gid})`}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="20.4" r="1.3" fill={`url(#${gid})`} />
    </svg>
  );
}
