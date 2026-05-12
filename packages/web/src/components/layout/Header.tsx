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
    <header className="flex h-12 shrink-0 items-center border-b-[3px] border-black px-6 bg-white">
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <h1 className="text-base font-semibold text-black">{title}</h1>
        {subtitle ? (
          <button
            onClick={copyPath}
            className="group flex items-center gap-1 text-xs text-[#4A4A4A] truncate max-w-sm hover:text-black transition-colors text-left"
            title={subtitle}
          >
            <span className="truncate font-mono">{smartPath(subtitle)}</span>
            {copied ? (
              <Check className="h-3 w-3 shrink-0 text-[#008000]" />
            ) : (
              <Copy className="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-100" />
            )}
          </button>
        ) : projectName ? (
          <span className="text-xs text-[#4A4A4A]">{projectName}</span>
        ) : connected !== undefined ? (
          <span className="text-xs text-[#666666] italic">No project</span>
        ) : null}
      </div>
      <div className="ml-auto flex items-center gap-3">
        {subtitle && !isDocker && (
          <button
            onClick={openInVSCode}
            className="flex items-center gap-1.5 px-3 py-2 border-[3px] border-black text-xs font-semibold text-black hover:bg-black hover:text-white transition-colors"
            title="Open in VS Code"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span>Open in IDE</span>
          </button>
        )}
        {connected !== undefined && (
          <div className="flex items-center gap-2">
            <div className={cn('h-2 w-2', connected ? 'bg-[#008000]' : 'bg-[#666666]')} />
            <span className="text-xs text-[#666666]">
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        )}
      </div>
    </header>
  );
}
