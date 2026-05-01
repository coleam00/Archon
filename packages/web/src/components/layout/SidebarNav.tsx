import { useEffect, useRef, useState } from 'react';
import { NavLink, Link, useLocation, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Compass,
  Inbox,
  MessageSquare,
  Radio,
  Workflow,
  Settings,
  Layers,
  CheckCircle,
  List,
  Rss,
  GalleryHorizontal,
  GitBranch,
  Sparkles,
  ChevronDown,
  Github,
  Sun,
  Moon,
  type LucideIcon,
} from 'lucide-react';
import { listDashboardRuns, getUpdateCheck, getOperator, type CodebaseResponse } from '@/lib/api';
import { useProject } from '@/contexts/ProjectContext';
import { cn } from '@/lib/utils';

type ThemeMode = 'light' | 'dark';
const THEME_STORAGE_KEY = 'archon-theme';

function loadTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === 'dark' || v === 'light') return v;
  } catch {
    // localStorage unavailable
  }
  return 'light';
}

function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
}

const APP_TABS: { to: string; icon: LucideIcon; label: string }[] = [
  { to: '/chat', icon: MessageSquare, label: 'Chat' },
  { to: '/mission', icon: Radio, label: 'Mission' },
  { to: '/workflows', icon: Workflow, label: 'Workflows' },
  { to: '/compass', icon: Compass, label: 'Compass' },
  { to: '/symphony', icon: Inbox, label: 'Symphony' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

const MISSION_TABS: { tab: string; icon: LucideIcon; label: string }[] = [
  { tab: 'board', icon: Layers, label: 'Board' },
  { tab: 'approvals', icon: CheckCircle, label: 'Approvals' },
  { tab: 'history', icon: List, label: 'History' },
  { tab: 'symphony', icon: Inbox, label: 'Symphony' },
  { tab: 'feed', icon: Rss, label: 'Feed' },
  { tab: 'artifacts', icon: GalleryHorizontal, label: 'Artifacts' },
  { tab: 'worktrees', icon: GitBranch, label: 'Worktrees' },
];

export function SidebarNav(): React.ReactElement {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const onMission = location.pathname.startsWith('/mission');
  const activeMissionTab = searchParams.get('tab') ?? 'board';

  // Counts for the Approvals sub-nav badge (only when on Mission to avoid noise).
  const { data: dashboardRuns } = useQuery({
    queryKey: ['dashboardRuns', { status: 'paused', forCount: true }],
    queryFn: () => listDashboardRuns({ status: 'paused', limit: 1 }),
    refetchInterval: 10_000,
  });
  const pausedCount = dashboardRuns?.counts.paused ?? 0;

  return (
    <aside className="sticky top-0 flex h-screen w-[232px] shrink-0 flex-col border-r border-bridges-border-subtle bg-bridges-bg">
      <BrandRow />
      <OperatorPill />

      <nav className="flex flex-1 flex-col gap-px overflow-y-auto px-2.5 pt-1.5">
        <SectionLabel>Archon</SectionLabel>
        {APP_TABS.map(t => {
          const isMissionRow = t.to === '/mission';
          return (
            <div key={t.to}>
              <SidebarLink
                to={t.to}
                icon={t.icon}
                label={t.label}
                badge={isMissionRow && !onMission && pausedCount > 0 ? pausedCount : null}
                active={
                  isMissionRow
                    ? onMission
                    : location.pathname === t.to || location.pathname.startsWith(`${t.to}/`)
                }
              />
              {isMissionRow && onMission && (
                <div className="mt-0.5 mb-1 flex flex-col gap-px pl-3">
                  {MISSION_TABS.map(sub => {
                    const isApprovals = sub.tab === 'approvals';
                    const showBadge = isApprovals && pausedCount > 0;
                    return (
                      <SidebarSubLink
                        key={sub.tab}
                        to={`/mission?tab=${sub.tab}`}
                        icon={sub.icon}
                        label={sub.label}
                        badge={showBadge ? pausedCount : null}
                        active={activeMissionTab === sub.tab}
                        emphasizeBadge={isApprovals}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        <SectionLabel className="mt-3">Other</SectionLabel>
        <button
          disabled
          className="flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] text-bridges-fg-placeholder"
        >
          <Sparkles className="h-[15px] w-[15px]" />
          <span className="flex-1">Evals</span>
          <span className="text-[10px] text-bridges-fg-placeholder">soon</span>
        </button>
      </nav>

      <SidebarFooter />
    </aside>
  );
}

// ---------- Brand row ----------

function BrandRow(): React.ReactElement {
  return (
    <Link
      to="/chat"
      className="flex items-center gap-2.5 border-b border-bridges-border-subtle px-3.5 pt-3.5 pb-2.5 hover:opacity-90"
    >
      <div className="flex h-6 w-6 items-center justify-center rounded-md bg-bridges-action">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path
            d="M5 18 L12 5 L19 18 M8 14 H16"
            stroke="#fff"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-[13px] font-semibold tracking-tight text-bridges-fg1">archon</span>
        <span className="text-[11px] text-bridges-fg3">Mission Control</span>
      </div>
      <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] font-medium text-bridges-success">
        <span
          className="h-1.5 w-1.5 rounded-full bg-bridges-success"
          style={{ boxShadow: '0 0 0 3px rgba(16,185,129,0.18)' }}
        />
        live
      </span>
    </Link>
  );
}

// ---------- Operator pill ----------

const AVATAR_TINTS = [
  ['#FCE7F3', '#BE185D'],
  ['#DBEAFE', '#1E40AF'],
  ['#D1FAE5', '#065F46'],
  ['#EDE9FE', '#6D28D9'],
  ['#FFEDD5', '#C2410C'],
  ['#E0E7FF', '#3730A3'],
  ['#FEF3C7', '#92400E'],
  ['#FFE4E6', '#9F1239'],
] as const;

function tintFor(name: string): readonly [string, string] {
  return AVATAR_TINTS[(name.charCodeAt(0) || 0) % AVATAR_TINTS.length] ?? AVATAR_TINTS[0];
}

function initialsFor(name: string): string {
  return name
    .split(/[\s._-]/)
    .map(s => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function fmtUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  if (days >= 1) return `${days.toString()}d`;
  const hours = Math.floor(seconds / 3600);
  if (hours >= 1) return `${hours.toString()}h`;
  const mins = Math.floor(seconds / 60);
  return `${mins.toString()}m`;
}

function OperatorPill(): React.ReactElement {
  const { data } = useQuery({
    queryKey: ['operator'],
    queryFn: getOperator,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const name = data?.name ?? '...';
  const host = data?.host ?? '';
  const uptime = data ? fmtUptime(data.uptimeSeconds) : '';
  const [bg, fg] = tintFor(name);

  return (
    <div className="px-2.5 pt-2.5 pb-2">
      <div className="flex items-center gap-2 rounded-md border border-bridges-border bg-bridges-surface px-2 py-1.5">
        <span
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
          style={{ background: bg, color: fg }}
        >
          {initialsFor(name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-bridges-fg1">{name}</div>
          {data && (
            <div className="truncate text-[10px] text-bridges-fg3">
              {host} · uptime {uptime}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Section label ----------

function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div
      className={cn(
        'px-2.5 pt-2.5 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-bridges-fg3',
        className
      )}
    >
      {children}
    </div>
  );
}

// ---------- Nav links ----------

interface SidebarLinkProps {
  to: string;
  icon: LucideIcon;
  label: string;
  badge: number | null;
  active: boolean;
}

function SidebarLink({
  to,
  icon: Icon,
  label,
  badge,
  active,
}: SidebarLinkProps): React.ReactElement {
  return (
    <NavLink
      to={to}
      className={cn(
        'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors',
        active
          ? 'bg-bridges-surface-muted font-medium text-bridges-fg1'
          : 'text-bridges-fg2 hover:bg-bridges-surface-subtle hover:text-bridges-fg1'
      )}
    >
      <Icon className="h-[15px] w-[15px] shrink-0" />
      <span className="flex-1">{label}</span>
      {badge != null && badge > 0 && (
        <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-bridges-trigger px-1.5 text-[11px] font-semibold leading-none text-white">
          {badge}
        </span>
      )}
    </NavLink>
  );
}

interface SidebarSubLinkProps {
  to: string;
  icon: LucideIcon;
  label: string;
  badge: number | null;
  active: boolean;
  emphasizeBadge?: boolean;
}

function SidebarSubLink({
  to,
  icon: Icon,
  label,
  badge,
  active,
  emphasizeBadge,
}: SidebarSubLinkProps): React.ReactElement {
  const animatedBadge = emphasizeBadge === true && badge != null && badge > 0;
  return (
    <NavLink
      to={to}
      className={cn(
        'flex items-center gap-2 rounded-md px-2.5 py-1 text-[12.5px] transition-colors',
        active
          ? 'bg-bridges-surface-muted font-medium text-bridges-fg1'
          : 'text-bridges-fg2 hover:bg-bridges-surface-subtle hover:text-bridges-fg1'
      )}
    >
      <Icon className="h-[13px] w-[13px] shrink-0" />
      <span className="flex-1">{label}</span>
      {badge != null && badge > 0 && (
        <span
          className={cn(
            'inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full px-1.5 text-[10.5px] font-semibold leading-none',
            animatedBadge
              ? 'bg-bridges-trigger text-white'
              : 'bg-bridges-surface-muted text-bridges-fg2'
          )}
          style={
            animatedBadge ? { animation: 'needs-me-pulse 2.4s ease-in-out infinite' } : undefined
          }
        >
          {badge}
        </span>
      )}
    </NavLink>
  );
}

// ---------- Footer ----------

function SidebarFooter(): React.ReactElement {
  const [theme, setTheme] = useState<ThemeMode>(() => loadTheme());

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // localStorage unavailable
    }
  }, [theme]);

  const { data: updateCheck } = useQuery({
    queryKey: ['update-check'],
    queryFn: getUpdateCheck,
    staleTime: 60 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000,
    retry: false,
  });

  return (
    <div className="border-t border-bridges-border-subtle px-3.5 pt-2.5 pb-3">
      <CodebaseChip />

      <div className="mt-2.5 flex items-center justify-between text-[10.5px] text-bridges-fg3">
        <span>v{import.meta.env.VITE_APP_VERSION as string}</span>
        <button
          onClick={() => {
            setTheme(prev => (prev === 'dark' ? 'light' : 'dark'));
          }}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-bridges-fg2 hover:bg-bridges-surface-subtle hover:text-bridges-fg1"
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
        </button>
      </div>

      {updateCheck?.updateAvailable && updateCheck.releaseUrl && (
        <a
          href={updateCheck.releaseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-bridges-open hover:underline"
          title={`v${updateCheck.latestVersion} available`}
        >
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-bridges-open" />v
          {updateCheck.latestVersion} available
        </a>
      )}
    </div>
  );
}

// ---------- Codebase chip ----------

function CodebaseChip(): React.ReactElement {
  const { selectedProjectId, setSelectedProjectId, codebases } = useProject();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return (): void => {
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [open]);

  const selected: CodebaseResponse | null =
    codebases?.find(c => c.id === selectedProjectId) ?? null;

  return (
    <div ref={ref} className="relative">
      <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-bridges-fg3">
        Codebase
      </div>
      <button
        onClick={() => {
          setOpen(prev => !prev);
        }}
        className="flex w-full items-center gap-2 rounded-md border border-bridges-border bg-bridges-surface px-2 py-1.5 text-left hover:border-bridges-border-strong"
      >
        <Github className="h-3.5 w-3.5 text-bridges-fg1" />
        <span className="flex-1 truncate font-mono text-[12px] text-bridges-fg1">
          {selected ? selected.name : 'No codebase'}
        </span>
        <ChevronDown className="h-3 w-3 text-bridges-fg3" />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 right-0 z-30 mb-1.5 max-h-72 overflow-y-auto rounded-md border border-bridges-border bg-bridges-surface py-1 shadow-lg">
          <button
            onClick={() => {
              setSelectedProjectId(null);
              setOpen(false);
            }}
            className={cn(
              'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-bridges-surface-subtle',
              selectedProjectId === null ? 'font-medium text-bridges-fg1' : 'text-bridges-fg2'
            )}
          >
            All projects
          </button>
          {codebases?.map(cb => (
            <button
              key={cb.id}
              onClick={() => {
                setSelectedProjectId(cb.id);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-bridges-surface-subtle',
                selectedProjectId === cb.id ? 'font-medium text-bridges-fg1' : 'text-bridges-fg2'
              )}
            >
              <Github className="h-3 w-3 shrink-0 text-bridges-fg2" />
              <span className="truncate font-mono text-[12px]">{cb.name}</span>
            </button>
          ))}
          {codebases?.length === 0 && (
            <div className="px-2.5 py-2 text-[11px] text-bridges-fg3">No codebases yet.</div>
          )}
        </div>
      )}
    </div>
  );
}
