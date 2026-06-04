import { NavLink, Link } from 'react-router';
import {
  PenLine,
  Activity,
  ClipboardList,
  Share2,
  Briefcase,
  Mail,
  FlaskConical,
  Wrench,
  CheckSquare,
  HardDrive,
  Home,
  BarChart2,
  Megaphone,
  Sparkles,
  Droplet,
  Leaf,
  Calendar,
  LineChart as LineChartIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// Static-build TopNav: backend-dependent items removed (Chat, Workflows,
// Dashboard, Settings, TTS). useQuery pollers removed. Public-safe nav only.
//
// Nav is split into two groups so we can render a visual divider between
// PMC's brand family and Jason's external-rep engagements (per 2026-06-02
// decision -- ARC + SADN are NOT PMC sub-brands).

interface NavTab {
  to: string;
  end: boolean;
  icon: typeof Home;
  label: string;
}

const coreTabs: readonly NavTab[] = [
  { to: '/welcome', end: true, icon: Home, label: 'Welcome' },
  { to: '/playground', end: false, icon: LineChartIcon, label: 'Playground' },
  { to: '/category/writing-comms', end: false, icon: Mail, label: 'Writing' },
  { to: '/category/research-learning', end: false, icon: FlaskConical, label: 'Research' },
  { to: '/category/techbase', end: false, icon: Wrench, label: 'Techbase' },
  { to: '/category/work-daily-ops', end: false, icon: CheckSquare, label: 'Daily Ops' },
  { to: '/drive', end: false, icon: HardDrive, label: 'Drive' },
  { to: '/solutions', end: false, icon: Briefcase, label: 'Solutions' },
  { to: '/pmc', end: false, icon: Briefcase, label: 'PMC' },
  { to: '/brt', end: false, icon: BarChart2, label: 'BRT' },
  { to: '/ewc', end: false, icon: Leaf, label: 'EWC' },
  { to: '/fountain', end: false, icon: Droplet, label: 'Fountain WPB' },
  { to: '/ttts', end: false, icon: Calendar, label: 'TTTS' },
  { to: '/ihht', end: false, icon: Activity, label: 'IHHT' },
  { to: '/qep', end: false, icon: ClipboardList, label: 'QEP' },
  { to: '/sg-ink', end: false, icon: PenLine, label: 'SG INK' },
  { to: '/social-content', end: false, icon: Share2, label: 'Social Content' },
] as const;

const externalRepTabs: readonly NavTab[] = [
  { to: '/external-reps/arc', end: false, icon: Megaphone, label: 'ARC' },
  { to: '/external-reps/sadn', end: false, icon: Sparkles, label: 'SADN' },
] as const;

function NavTabLink({ to, end, icon: Icon, label }: NavTab): React.ReactElement {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }: { isActive: boolean }): string =>
        cn(
          'flex items-center gap-2 px-3 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
          isActive
            ? 'border-primary text-primary'
            : 'border-transparent text-text-secondary hover:text-text-primary'
        )
      }
    >
      <Icon className="h-4 w-4" />
      {label}
    </NavLink>
  );
}

export function TopNav(): React.ReactElement {
  return (
    <nav className="flex items-center gap-1 border-b border-border bg-surface px-4 overflow-x-auto">
      <Link to="/welcome" className="flex items-center gap-2 mr-4 hover:opacity-80 transition-opacity">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary">
          <span className="text-sm font-semibold text-primary-foreground">P</span>
        </div>
        <span
          className="text-sm font-semibold text-text-primary whitespace-nowrap"
          style={{ fontFamily: "'Playfair Display', serif" }}
        >
          PMC
        </span>
      </Link>

      {coreTabs.map(tab => (
        <NavTabLink key={tab.to} {...tab} />
      ))}

      {/* External-rep section separator + label */}
      <div className="mx-2 flex items-center gap-2 border-l border-border pl-3 whitespace-nowrap">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
          External Reps
        </span>
      </div>

      {externalRepTabs.map(tab => (
        <NavTabLink key={tab.to} {...tab} />
      ))}

      <span className="ml-auto text-xs text-text-secondary whitespace-nowrap pr-2">
        v{(import.meta.env.VITE_APP_VERSION as string | undefined) ?? '0.0.0'}
      </span>
    </nav>
  );
}
