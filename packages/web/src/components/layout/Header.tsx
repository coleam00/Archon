import { useState } from 'react';
import { ExternalLink, Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface HeaderProps {
  title: string;
  subtitle?: string;
  projectName?: string;
  connected?: boolean;
  isDocker?: boolean;
}

function smartPath(fullPath: string): string {
  const segments = fullPath.split('/').filter(Boolean);
  if (segments.length <= 3) return fullPath;
  return '.../' + segments.slice(-3).join('/');
}

export function Header({
  title,
  subtitle,
  projectName,
  connected,
  isDocker,
}: HeaderProps): React.ReactElement {
  const [copied, setCopied] = useState(false);

  const openInVSCode = (): void => {
    if (subtitle) {
      // Normalize backslashes to forward slashes for the vscode:// URI
      const normalizedPath = subtitle.replace(/\\/g, '/');
      window.open(`vscode://file/${normalizedPath}`, '_blank');
    }
  };

  const copyPath = (): void => {
    if (subtitle) {
      void navigator.clipboard.writeText(subtitle).then(() => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 1500);
      });
    }
  };

  return (
    <header className="flex h-12 shrink-0 items-center border-b border-border px-6">
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <h1 className="text-base font-semibold text-text-primary">{title}</h1>
        {subtitle ? (
          <button
            onClick={copyPath}
            className="group flex items-center gap-1 text-xs text-text-secondary truncate max-w-sm hover:text-text-primary transition-colors text-left"
            title={subtitle}
          >
            <span className="truncate">{smartPath(subtitle)}</span>
            {copied ? (
              <Check className="h-3 w-3 shrink-0 text-success" />
            ) : (
              <Copy className="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-100" />
            )}
          </button>
        ) : projectName ? (
          <span className="text-xs text-text-secondary">{projectName}</span>
        ) : connected !== undefined ? (
          <span className="text-xs text-text-tertiary italic">No project</span>
        ) : null}
      </div>
      <div className="ml-auto flex items-center gap-3">
        {subtitle && !isDocker && (
          <button
            onClick={openInVSCode}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-surface hover:text-text-primary transition-colors"
            title="Open in VS Code"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span>Open in IDE</span>
          </button>
        )}
        {connected !== undefined && (
          <div className="flex items-center gap-2">
            <div
              className={cn('h-2 w-2 rounded-full', connected ? 'bg-success' : 'bg-text-tertiary')}
            />
            <span className="text-xs text-text-tertiary">
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        )}
      </div>
    </header>
  );
}
