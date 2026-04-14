# Patch : UI Mobile-Responsive — Archon

> **Date du patch :** Avril 2026  
> **Auteur :** Roland Galzy  
> **Version Archon ciblée :** branche `main` / tag à préciser lors de la prochaine mise à jour

---

## Pourquoi ce patch existe

Archon est déployé localement et exposé via un tunnel Cloudflare (`cloudflared`) pour permettre un accès depuis un smartphone ou une tablette. L'interface d'origine n'étant pas conçue pour les petits écrans (navigation en haut de page non adaptée, panneau latéral gauche du chat prenant toute la largeur), une série de modifications a été appliquée pour rendre l'UI pleinement utilisable sur mobile.

**Changements principaux :**

1. Création d'un **contexte React partagé** (`MobileNavContext`) pour synchroniser l'état du drawer mobile.
2. Ajout d'un **drawer de navigation latéral** dans `Layout.tsx` (visible uniquement sur mobile).
3. Transformation de la **TopNav** : bouton hamburger ☰ sur mobile, comportement inchangé sur desktop.
4. Masquage du **panneau gauche de ChatPage** sur mobile (conversations), la zone de chat prend toute la largeur.

---

## Fichiers modifiés

### 1. `packages/web/src/contexts/MobileNavContext.tsx` _(nouveau fichier)_

**Rôle :** Contexte React permettant à `Layout.tsx` et `TopNav.tsx` de partager l'état d'ouverture du drawer mobile (`open` / `setOpen`) sans props drilling.

**Code complet :**

```tsx
import { createContext, useContext } from 'react';

export interface MobileNavContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const MobileNavContext = createContext<MobileNavContextValue>({
  open: false,
  setOpen: () => {},
});

export function useMobileNav(): MobileNavContextValue {
  return useContext(MobileNavContext);
}
```

---

### 2. `packages/web/src/components/layout/Layout.tsx` _(modifié)_

**Changements apportés :**

- Import de `useState`, des icônes Lucide (`MessageSquare`, `LayoutDashboard`, `Workflow`, `Settings`, `X`) et de `NavLink` depuis `react-router`.
- Import de `MobileNavContext` et `cn`.
- Ajout de l'état `open` / `setOpen` via `useState(false)`.
- Enveloppe le JSX dans `<MobileNavContext.Provider value={{ open, setOpen }}>`.
- Ajout d'un **backdrop overlay** semi-transparent (cliquable pour fermer) : `fixed inset-0 z-40 bg-black/60 md:hidden`.
- Ajout d'un **drawer `<aside>`** glissant depuis la gauche : `w-72`, `z-50`, transition CSS `translate-x`, caché sur `md:` via `md:hidden`.
- Le drawer contient : logo + bouton ✕ en en-tête, liens de navigation (Chat/Dashboard/Workflows), Settings épinglé en bas de drawer.

**Code complet :**

```tsx
import { useState } from 'react';
import { Outlet, NavLink } from 'react-router';
import { MessageSquare, LayoutDashboard, Workflow, Settings, X } from 'lucide-react';
import { TopNav } from './TopNav';
import { MobileNavContext } from '@/contexts/MobileNavContext';
import { cn } from '@/lib/utils';

const navItems = [
  { to: '/chat', end: false, icon: MessageSquare, label: 'Chat' },
  { to: '/dashboard', end: true, icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/workflows', end: false, icon: Workflow, label: 'Workflows' },
] as const;

export function Layout(): React.ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <MobileNavContext.Provider value={{ open, setOpen }}>
      <div className="flex h-screen flex-col bg-background">
        <TopNav />

        {/* ── Mobile nav overlay backdrop ── */}
        {open && (
          <div
            className="fixed inset-0 z-40 bg-black/60 md:hidden"
            onClick={() => {
              setOpen(false);
            }}
            aria-hidden="true"
          />
        )}

        {/* ── Mobile nav drawer ── */}
        <aside
          className={cn(
            'fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-surface border-r border-border shadow-2xl',
            'transition-transform duration-300 ease-in-out',
            'md:hidden',
            open ? 'translate-x-0' : '-translate-x-full'
          )}
          aria-label="Navigation mobile"
        >
          {/* Drawer header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary">
                <span className="text-sm font-semibold text-primary-foreground">A</span>
              </div>
              <span className="text-sm font-semibold text-text-primary">Archon</span>
            </div>
            <button
              onClick={() => {
                setOpen(false);
              }}
              className="flex items-center justify-center rounded-md p-1.5 text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors"
              aria-label="Fermer le menu"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Navigation links */}
          <nav className="flex-1 overflow-y-auto p-2 pt-3">
            {navItems.map(({ to, end, icon: Icon, label }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                onClick={() => {
                  setOpen(false);
                }}
                className={({ isActive }: { isActive: boolean }): string =>
                  cn(
                    'flex items-center gap-3 w-full rounded-md px-3 py-2.5 text-sm font-medium transition-colors mb-0.5',
                    isActive
                      ? 'bg-accent text-primary'
                      : 'text-text-secondary hover:bg-surface-elevated hover:text-text-primary'
                  )
                }
              >
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </NavLink>
            ))}
          </nav>

          {/* Settings — pinned at bottom */}
          <div className="p-2 border-t border-border">
            <NavLink
              to="/settings"
              onClick={() => {
                setOpen(false);
              }}
              className={({ isActive }: { isActive: boolean }): string =>
                cn(
                  'flex items-center gap-3 w-full rounded-md px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-accent text-primary'
                    : 'text-text-secondary hover:bg-surface-elevated hover:text-text-primary'
                )
              }
            >
              <Settings className="h-4 w-4 shrink-0" />
              Settings
            </NavLink>
          </div>
        </aside>

        <main className="flex flex-1 flex-col overflow-hidden">
          <Outlet />
        </main>
      </div>
    </MobileNavContext.Provider>
  );
}
```

---

### 3. `packages/web/src/components/layout/TopNav.tsx` _(modifié)_

**Changements apportés :**

- Import de `useMobileNav` depuis `@/contexts/MobileNavContext`.
- Import de l'icône `Menu` depuis `lucide-react`.
- Récupération de `setOpen` via `useMobileNav()`.
- Ajout du **bouton hamburger** `<Menu>` avant le logo : `md:hidden`, déclenche `setOpen(true)`.
- Les onglets de navigation sont enveloppés dans `<div className="hidden md:flex ...">` → **invisibles sur mobile**.
- Le logo reste visible sur mobile et desktop.
- Version badge et update check : comportement inchangé.

**Code complet :**

```tsx
import { NavLink, Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { LayoutDashboard, MessageSquare, Workflow, Settings, Menu } from 'lucide-react';
import { listWorkflowRuns, getUpdateCheck } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useMobileNav } from '@/contexts/MobileNavContext';

const tabs = [
  { to: '/chat', end: false, icon: MessageSquare, label: 'Chat' },
  { to: '/dashboard', end: true, icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/workflows', end: false, icon: Workflow, label: 'Workflows' },
  { to: '/settings', end: false, icon: Settings, label: 'Settings' },
] as const;

export function TopNav(): React.ReactElement {
  const { setOpen } = useMobileNav();

  const { data: runningRuns } = useQuery({
    queryKey: ['workflowRuns', { status: 'running' }],
    queryFn: () => listWorkflowRuns({ status: 'running', limit: 1 }),
    refetchInterval: 10_000,
  });
  const hasRunning = (runningRuns?.length ?? 0) > 0;

  const { data: updateCheck } = useQuery({
    queryKey: ['update-check'],
    queryFn: getUpdateCheck,
    staleTime: 60 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000,
    retry: false,
  });

  return (
    <nav className="flex items-center gap-1 border-b border-border bg-surface px-4">
      {/* ── Mobile: hamburger button (hidden on desktop) ── */}
      <button
        onClick={() => {
          setOpen(true);
        }}
        className="flex items-center justify-center rounded-md p-1.5 mr-2 text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors md:hidden"
        aria-label="Ouvrir le menu"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Brand logo */}
      <Link to="/chat" className="flex items-center gap-2 mr-4 hover:opacity-80 transition-opacity">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary">
          <span className="text-sm font-semibold text-primary-foreground">A</span>
        </div>
        {/* Logo text: always visible */}
        <span className="text-sm font-semibold text-text-primary">Archon</span>
      </Link>

      {/* ── Desktop nav tabs (hidden on mobile) ── */}
      <div className="hidden md:flex items-center gap-1">
        {tabs.map(({ to, end, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }: { isActive: boolean }): string =>
              cn(
                'flex items-center gap-2 px-3 py-3 text-sm font-medium border-b-2 transition-colors',
                isActive
                  ? 'border-primary text-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              )
            }
          >
            <Icon className="h-4 w-4" />
            {label}
            {to === '/dashboard' && hasRunning && (
              <span className="flex h-2 w-2 rounded-full bg-primary animate-pulse" />
            )}
          </NavLink>
        ))}
      </div>

      {/* Version + update badge */}
      <span className="ml-auto text-xs text-text-secondary">
        v{import.meta.env.VITE_APP_VERSION as string}
        {updateCheck?.updateAvailable && updateCheck.releaseUrl && (
          <a
            href={updateCheck.releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-1.5 inline-flex items-center gap-1 text-xs text-primary hover:underline"
            title={`v${updateCheck.latestVersion} available`}
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />v
            {updateCheck.latestVersion}
          </a>
        )}
      </span>
    </nav>
  );
}
```

---

### 4. `packages/web/src/routes/ChatPage.tsx` _(modifié)_

**Changements apportés :**

- Le **panneau gauche** (liste des conversations) reçoit la classe `hidden md:flex` → masqué sur mobile, visible à partir de `md:` (768px).
- Le **panneau droit** (interface de chat) reçoit `flex flex-1 flex-col overflow-hidden min-w-0` → prend toute la largeur disponible sur mobile.
- Aucun autre changement fonctionnel (resize handle, state management, queries, etc. sont identiques à l'original).

**Diff commenté (section JSX return uniquement) :**

```diff
  return (
    <div className="flex flex-1 overflow-hidden">

-     {/* Left panel */}
-     <div
-       className="relative flex h-full flex-col border-r border-border bg-surface overflow-hidden"
+     {/* ── Left panel — hidden on mobile, always visible on desktop ── */}
+     <div
+       className={cn(
+         'relative flex h-full flex-col border-r border-border bg-surface overflow-hidden',
+         // Hide entirely on mobile → chat takes full width
+         'hidden md:flex'
+       )}
        style={{ width: `${String(width)}px`, flexShrink: 0 }}
      >
        {/* ... contenu inchangé ... */}
      </div>

-     {/* Right panel */}
-     <div className="flex flex-1 flex-col overflow-hidden">
+     {/* ── Right panel — chat interface, full width on mobile ── */}
+     <div className="flex flex-1 flex-col overflow-hidden min-w-0">
        <ChatInterface key={conversationId ?? 'new'} conversationId={conversationId ?? 'new'} />
      </div>
    </div>
  );
```

**Code complet du fichier :**

```tsx
import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquarePlus, Search, Plus, Loader2, FolderGit2 } from 'lucide-react';
import { ChatInterface } from '@/components/chat/ChatInterface';
import { ConversationItem } from '@/components/conversations/ConversationItem';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useProject } from '@/contexts/ProjectContext';
import { listConversations, listWorkflowRuns, addCodebase } from '@/lib/api';
import type { CodebaseResponse } from '@/lib/api';
import { cn } from '@/lib/utils';

const PANEL_MIN = 220;
const PANEL_MAX = 420;
const PANEL_DEFAULT = 260;
const STORAGE_KEY = 'archon-chat-panel-width';

function getInitialWidth(): number {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    const parsed = Number(stored);
    if (parsed >= PANEL_MIN && parsed <= PANEL_MAX) return parsed;
  }
  return PANEL_DEFAULT;
}

export function ChatPage(): React.ReactElement {
  const { '*': rawConversationId } = useParams();
  const conversationId = rawConversationId ? decodeURIComponent(rawConversationId) : undefined;

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedProjectId, setSelectedProjectId, codebases, isLoadingCodebases } = useProject();

  const [searchQuery, setSearchQuery] = useState('');
  const [width, setWidth] = useState(getInitialWidth);
  const isResizing = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Add-project state
  const [showAddInput, setShowAddInput] = useState(false);
  const [addValue, setAddValue] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const addInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(width));
  }, [width]);

  useEffect(() => {
    if (showAddInput) {
      addInputRef.current?.focus();
    }
  }, [showAddInput]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault();
      isResizing.current = true;
      const startX = e.clientX;
      const startWidth = width;

      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';

      const onMouseMove = (moveEvent: MouseEvent): void => {
        const newWidth = Math.min(
          PANEL_MAX,
          Math.max(PANEL_MIN, startWidth + moveEvent.clientX - startX)
        );
        setWidth(newWidth);
      };

      const onMouseUp = (): void => {
        isResizing.current = false;
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [width]
  );

  const { data: conversations } = useQuery({
    queryKey: ['conversations', selectedProjectId],
    queryFn: () => listConversations(selectedProjectId ?? undefined),
    refetchInterval: 10_000,
  });

  const { data: runs } = useQuery({
    queryKey: ['workflow-runs-status'],
    queryFn: () => listWorkflowRuns({ limit: 50 }),
    refetchInterval: 10_000,
  });

  const conversationStatusMap = useMemo((): Map<string, 'running' | 'failed'> => {
    const map = new Map<string, 'running' | 'failed'>();
    if (!runs) return map;
    for (const run of runs) {
      const key = run.parent_conversation_id ?? run.conversation_id;
      if (run.status === 'running') {
        map.set(key, 'running');
      } else if (run.status === 'failed' && !map.has(key)) {
        map.set(key, 'failed');
      }
    }
    return map;
  }, [runs]);

  const codebaseMap = useMemo((): Map<string, CodebaseResponse> => {
    const map = new Map<string, CodebaseResponse>();
    if (codebases) {
      for (const cb of codebases) {
        map.set(cb.id, cb);
      }
    }
    return map;
  }, [codebases]);

  const filtered = useMemo(
    () =>
      conversations?.filter(conv => {
        if (!searchQuery) return true;
        const query = searchQuery.toLowerCase();
        return (conv.title ?? conv.platform_conversation_id).toLowerCase().includes(query);
      }),
    [conversations, searchQuery]
  );

  const handleNewChat = useCallback((): void => {
    navigate('/chat');
  }, [navigate]);

  const handleAddSubmit = useCallback((): void => {
    const trimmed = addValue.trim();
    if (!trimmed || addLoading) return;

    setAddLoading(true);
    setAddError(null);

    const isLocalPath =
      trimmed.startsWith('/') || trimmed.startsWith('~') || /^[A-Za-z]:[/\\]/.test(trimmed);
    const input = isLocalPath ? { path: trimmed } : { url: trimmed };

    void addCodebase(input)
      .then(codebase => {
        void queryClient.invalidateQueries({ queryKey: ['codebases'] });
        setSelectedProjectId(codebase.id);
        setShowAddInput(false);
        setAddValue('');
        setAddError(null);
      })
      .catch((err: Error) => {
        setAddError(err.message);
      })
      .finally(() => {
        setAddLoading(false);
      });
  }, [addValue, addLoading, queryClient, setSelectedProjectId]);

  const handleAddKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key === 'Enter') {
        handleAddSubmit();
      } else if (e.key === 'Escape') {
        setShowAddInput(false);
        setAddValue('');
        setAddError(null);
      }
    },
    [handleAddSubmit]
  );

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* ── Left panel — hidden on mobile, always visible on desktop ── */}
      <div
        className={cn(
          'relative flex h-full flex-col border-r border-border bg-surface overflow-hidden',
          // Hide entirely on mobile → chat takes full width
          'hidden md:flex'
        )}
        style={{ width: `${String(width)}px`, flexShrink: 0 }}
      >
        {/* New Chat button */}
        <div className="px-3 pt-3 pb-2">
          <button
            onClick={handleNewChat}
            className="flex w-full items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-accent-hover transition-colors"
          >
            <MessageSquarePlus className="h-4 w-4 shrink-0" />
            New Chat
          </button>
        </div>

        {/* Project filter */}
        <div className="px-3 pb-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
              Project
            </span>
            <button
              onClick={(): void => {
                setShowAddInput(prev => !prev);
                setAddError(null);
                setAddValue('');
              }}
              className="p-1 rounded hover:bg-surface-elevated transition-colors"
              title="Add project"
            >
              <Plus className="h-3.5 w-3.5 text-text-tertiary hover:text-primary" />
            </button>
          </div>

          {showAddInput && (
            <div className="mb-2">
              <div className="flex items-center gap-1">
                <input
                  ref={addInputRef}
                  value={addValue}
                  onChange={(e): void => {
                    setAddValue(e.target.value);
                  }}
                  onKeyDown={handleAddKeyDown}
                  onBlur={(): void => {
                    if (!addValue.trim() && !addError) {
                      setShowAddInput(false);
                    }
                  }}
                  placeholder="GitHub URL or local path"
                  disabled={addLoading}
                  className="w-full rounded-md border border-border bg-surface-elevated px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none disabled:opacity-50"
                />
                {addLoading && (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                )}
              </div>
              {addError && <p className="mt-1 text-[10px] text-error line-clamp-2">{addError}</p>}
            </div>
          )}

          {isLoadingCodebases ? (
            <div className="flex items-center justify-center py-2">
              <span className="text-xs text-text-tertiary">Loading...</span>
            </div>
          ) : (
            <select
              value={selectedProjectId ?? ''}
              onChange={(e): void => {
                setSelectedProjectId(e.target.value || null);
              }}
              className="w-full rounded-md border border-border bg-surface-elevated px-2 py-1.5 text-xs text-text-primary focus:border-primary focus:outline-none"
            >
              <option value="">All Projects</option>
              {codebases?.map(cb => (
                <option key={cb.id} value={cb.id}>
                  {cb.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <Separator className="bg-border" />

        {/* Search */}
        <div className="px-3 py-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-tertiary" />
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e): void => {
                setSearchQuery(e.target.value);
              }}
              placeholder="Search..."
              className="w-full rounded-md border border-border bg-surface-elevated py-1.5 pl-7 pr-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none"
            />
          </div>
        </div>

        {/* Conversation list */}
        <ScrollArea className="flex-1 min-h-0 px-2 pb-2">
          <div className="flex flex-col gap-0.5">
            {filtered && filtered.length > 0 ? (
              filtered.map(conv => (
                <ConversationItem
                  key={conv.id}
                  conversation={conv}
                  projectName={
                    conv.codebase_id ? codebaseMap.get(conv.codebase_id)?.name : undefined
                  }
                  status={conversationStatusMap.get(conv.id) ?? 'idle'}
                />
              ))
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 py-8 px-4">
                <FolderGit2 className="h-8 w-8 text-text-tertiary" />
                <span className="text-xs text-text-tertiary text-center">
                  {conversations && conversations.length > 0
                    ? 'No matching conversations'
                    : 'No conversations yet — start a new chat!'}
                </span>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Resize handle */}
        <div
          onMouseDown={handleMouseDown}
          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize bg-border/50 hover:bg-primary/40 transition-colors"
        />
      </div>

      {/* ── Right panel — chat interface, full width on mobile ── */}
      <div className="flex flex-1 flex-col overflow-hidden min-w-0">
        <ChatInterface key={conversationId ?? 'new'} conversationId={conversationId ?? 'new'} />
      </div>
    </div>
  );
}
```

---

## Comment re-appliquer ce patch

### Option A — Re-application manuelle (fichier par fichier)

1. **Créer le fichier de contexte** _(s'il a été supprimé par une mise à jour)_ :

   ```text
   packages/web/src/contexts/MobileNavContext.tsx
   ```

   → Copier-coller le code de la section 1 ci-dessus.

2. **Remplacer `Layout.tsx`** :

   ```text
   packages/web/src/components/layout/Layout.tsx
   ```

   → Remplacer le contenu par le code de la section 2.

3. **Remplacer `TopNav.tsx`** :

   ```text
   packages/web/src/components/layout/TopNav.tsx
   ```

   → Remplacer le contenu par le code de la section 3.

4. **Remplacer `ChatPage.tsx`** :

   ```text
   packages/web/src/routes/ChatPage.tsx
   ```

   → Remplacer le contenu par le code de la section 4.

5. **Rebuilder le front** :

   ```bash
   cd packages/web
   npm run build
   # ou si dev :
   npm run dev
   ```

---

### Option B — Script PowerShell automatisé

Sauvegarder ce script sous `apply-responsive-patch.ps1` à la racine d'Archon et l'exécuter depuis PowerShell :

```powershell
# apply-responsive-patch.ps1
# Re-applique le patch mobile-responsive sur Archon
# Usage : .\apply-responsive-patch.ps1

$root = $PSScriptRoot
$web  = Join-Path $root "packages\web\src"

Write-Host "==> Application du patch mobile-responsive Archon..." -ForegroundColor Cyan

# 1. MobileNavContext.tsx
$contextDir = Join-Path $web "contexts"
if (-not (Test-Path $contextDir)) { New-Item -ItemType Directory -Path $contextDir | Out-Null }

$mobileNavContext = @'
import { createContext, useContext } from 'react';

export interface MobileNavContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const MobileNavContext = createContext<MobileNavContextValue>({
  open: false,
  setOpen: () => {},
});

export function useMobileNav(): MobileNavContextValue {
  return useContext(MobileNavContext);
}
'@
Set-Content -Path (Join-Path $contextDir "MobileNavContext.tsx") -Value $mobileNavContext -Encoding UTF8
Write-Host "  [OK] MobileNavContext.tsx" -ForegroundColor Green

# 2-4. Pour Layout.tsx, TopNav.tsx, ChatPage.tsx :
# Les fichiers sont trop longs pour être inlinés proprement dans un heredoc PS1.
# Copier les fichiers depuis une sauvegarde ou depuis ce document.

Write-Host ""
Write-Host "  [INFO] Pour Layout.tsx, TopNav.tsx et ChatPage.tsx :" -ForegroundColor Yellow
Write-Host "  Copier les codes complets depuis RESPONSIVE_UI_PATCH.md" -ForegroundColor Yellow
Write-Host "  sections 2, 3 et 4 respectivement." -ForegroundColor Yellow
Write-Host ""
Write-Host "==> MobileNavContext.tsx re-créé. Compléter manuellement les 3 autres fichiers." -ForegroundColor Cyan
```

> **Astuce :** Pour une automation complète, les codes des sections 2, 3 et 4 peuvent être stockés dans des fichiers `.patch` ou des fichiers de sauvegarde séparés (`Layout.tsx.bak`, etc.) et copiés par le script.

---

## Vérification

Après re-application du patch, vérifier les points suivants :

### Sur desktop (≥ 768px)

- [ ] La TopNav affiche les onglets (Chat / Dashboard / Workflows / Settings) normalement.
- [ ] Le bouton hamburger ☰ n'est **pas** visible.
- [ ] Le panneau gauche (liste des conversations) est visible dans ChatPage.
- [ ] Le drawer mobile n'apparaît pas.

### Sur mobile (< 768px) — via tunnel Cloudflare ou DevTools

- [ ] La TopNav affiche uniquement le bouton hamburger ☰ + le logo "Archon".
- [ ] Les onglets de navigation sont cachés.
- [ ] Cliquer sur ☰ ouvre le drawer latéral gauche.
- [ ] Le drawer contient : Chat, Dashboard, Workflows, Settings.
- [ ] Cliquer sur un lien du drawer navigue correctement et ferme le drawer.
- [ ] Le backdrop semi-transparent est visible derrière le drawer ; cliquer dessus ferme le drawer.
- [ ] Dans ChatPage, la zone de chat occupe toute la largeur (le panneau de conversations est masqué).
- [ ] TypeScript compile sans erreur : `npm run build` dans `packages/web`.

---

## Notes techniques

- **Breakpoint mobile/desktop :** `md:` = 768px (Tailwind default). Modifier dans `tailwind.config.ts` si besoin d'un seuil différent.
- **`cn()` :** Utilitaire Tailwind merge déjà présent dans `@/lib/utils`. Aucune dépendance supplémentaire.
- **`MobileNavContext` :** Le Provider est dans `Layout.tsx`. `TopNav` est toujours un enfant de `Layout`, donc `useMobileNav()` fonctionne partout dans l'arborescence.
- **Lucide icons ajoutées :** `Menu` (TopNav), `X` (Layout). Ces icônes font partie de `lucide-react` déjà installé.
