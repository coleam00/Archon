import { useState, useRef, useCallback, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import { Search, PanelLeft, X, ArrowLeft } from 'lucide-react';
import { ChatInterface } from '@/components/chat/ChatInterface';
import { ProjectsSidebar } from '@/components/sidebar/ProjectsSidebar';
import { useProject } from '@/contexts/ProjectContext';
import { cn } from '@/lib/utils';

const PANEL_MIN = 220;
const PANEL_MAX = 420;
const PANEL_DEFAULT = 260;
const STORAGE_KEY = 'archon-chat-panel-width';

function getInitialWidth(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = Number(stored);
      if (parsed >= PANEL_MIN && parsed <= PANEL_MAX) return parsed;
    }
  } catch {
    // localStorage unavailable
  }
  return PANEL_DEFAULT;
}

export function ChatPage(): React.ReactElement {
  const { '*': rawConversationId } = useParams();
  const conversationId = rawConversationId ? decodeURIComponent(rawConversationId) : undefined;
  const navigate = useNavigate();

  const { selectedProjectId, codebases } = useProject();
  const activeProject = selectedProjectId
    ? (codebases?.find(cb => cb.id === selectedProjectId) ?? null)
    : null;

  const [searchQuery, setSearchQuery] = useState('');
  const [width, setWidth] = useState(getInitialWidth);
  const [mobileConvOpen, setMobileConvOpen] = useState(false);
  const isResizing = useRef(false);

  // Close mobile drawer on desktop resize
  useEffect(() => {
    const onResize = (): void => {
      if (window.innerWidth >= 768) setMobileConvOpen(false);
    };
    window.addEventListener('resize', onResize);
    return (): void => {
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault();
      isResizing.current = true;
      const startX = e.clientX;
      const startWidth = width;

      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';

      let currentWidth = startWidth;

      const onMouseMove = (moveEvent: MouseEvent): void => {
        const newWidth = Math.min(
          PANEL_MAX,
          Math.max(PANEL_MIN, startWidth + moveEvent.clientX - startX)
        );
        currentWidth = newWidth;
        setWidth(newWidth);
      };

      const onMouseUp = (): void => {
        isResizing.current = false;
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        try {
          localStorage.setItem(STORAGE_KEY, String(currentWidth));
        } catch {
          // localStorage unavailable
        }
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [width]
  );

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Mobile overlay backdrop */}
      {mobileConvOpen && (
        <div
          className="fixed inset-x-0 top-12 bottom-0 z-40 bg-black/60 md:hidden"
          onClick={(): void => {
            setMobileConvOpen(false);
          }}
          aria-hidden="true"
        />
      )}

      {/* Left panel: projects sidebar
          Desktop : inline sidebar (relative, h-full)
          Mobile  : fixed overlay drawer, slides from left */}
      <div
        className={cn(
          'flex flex-col border-r border-border overflow-hidden',
          'fixed top-12 bottom-0 left-0 z-50',
          'md:relative md:inset-auto md:z-auto md:h-full',
          'transition-transform duration-300 ease-in-out',
          mobileConvOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        )}
        style={{ width: `${String(width)}px`, flexShrink: 0, backgroundColor: 'var(--surface)' }}
      >
        {/* Mobile close + search row */}
        <div className="px-3 pt-3 pb-2 flex items-center gap-2 shrink-0">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-tertiary" />
            <input
              value={searchQuery}
              onChange={(e): void => {
                setSearchQuery(e.target.value);
              }}
              placeholder="Rechercher..."
              className="w-full rounded-md border border-border bg-surface-elevated py-1.5 pl-7 pr-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none"
            />
          </div>
          <button
            onClick={(): void => {
              setMobileConvOpen(false);
            }}
            className="md:hidden flex items-center justify-center rounded-md p-1.5 text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors"
            aria-label="Fermer le panneau projets"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <ProjectsSidebar
          searchQuery={searchQuery}
          onNavigate={(): void => {
            setMobileConvOpen(false);
          }}
        />

        {/* Resize handle — desktop only */}
        <div
          onMouseDown={handleMouseDown}
          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize bg-border/50 hover:bg-primary/40 transition-colors hidden md:block"
        />
      </div>

      {/* Right panel — chat interface */}
      <div className="flex flex-1 flex-col overflow-hidden min-w-0">
        {/* Mobile-only topbar */}
        <div className="sticky top-0 z-30 flex shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-2 md:hidden">
          {/* If a project is active and we have a conversationId, show back → project */}
          {activeProject && conversationId ? (
            <button
              onClick={(): void => {
                navigate(`/projects/${activeProject.id}`);
              }}
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors"
              aria-label={`Retour à ${activeProject.name}`}
            >
              <ArrowLeft className="h-4 w-4 shrink-0" />
              <span className="max-w-[160px] truncate text-xs font-medium">
                {activeProject.name}
              </span>
            </button>
          ) : (
            <button
              onClick={(): void => {
                setMobileConvOpen(true);
              }}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors"
              aria-label="Ouvrir le panneau projets"
            >
              <PanelLeft className="h-4 w-4 shrink-0" />
              <span className="text-xs font-medium">Projets</span>
            </button>
          )}
        </div>

        <ChatInterface key={conversationId ?? 'new'} conversationId={conversationId ?? 'new'} />
      </div>
    </div>
  );
}
