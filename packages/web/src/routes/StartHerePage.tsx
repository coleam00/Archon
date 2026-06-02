import { Link } from 'react-router';
import {
  HardDrive,
  Briefcase,
  Users,
  Mail,
  FlaskConical,
  Wrench,
  CheckSquare,
  BarChart2,
  Activity,
  Volume2,
  ClipboardList,
  PenLine,
  Share2,
} from 'lucide-react';

interface CardProps {
  to: string;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
}

function Card({ to, title, description, icon: Icon, badge }: CardProps): React.ReactElement {
  return (
    <Link
      to={to}
      className="group flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 transition-colors hover:border-zinc-600 hover:bg-zinc-900/60"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-text-secondary" />
          <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        </div>
        {badge && (
          <span className="rounded-full bg-emerald-900/40 px-2 py-0.5 text-[10px] text-emerald-300">
            {badge}
          </span>
        )}
      </div>
      <p className="text-xs text-text-secondary">{description}</p>
    </Link>
  );
}

export function StartHerePage(): React.ReactElement {
  return (
    <div className="flex h-full flex-1 flex-col gap-6 overflow-y-auto p-6">
      {/* Hero */}
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold text-text-primary" style={{ fontFamily: "'Playfair Display', serif" }}>
          Welcome
        </h1>
        <p className="text-sm text-text-secondary">
          This is Jason Diaz's operations dashboard -- a single surface for the PMC
          portfolio, partner / solution catalog, Google Drive index, contacts,
          and live engagement state. Built to keep the team aligned and moving.
        </p>
        <div className="flex flex-wrap items-center gap-3 text-xs text-text-tertiary">
          <span>Single KPI:</span>
          <span className="rounded-full bg-emerald-900/40 px-2 py-0.5 text-emerald-300">
            first meetings booked / week
          </span>
          <span>Day-30 target: 8/wk · Day-90 target: 15/wk</span>
        </div>
      </div>

      {/* Three audience views explainer */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
        <h2 className="mb-2 text-base font-semibold text-text-primary">
          Three audience views
        </h2>
        <p className="mb-3 text-xs text-text-secondary">
          Append <code className="rounded bg-zinc-900 px-1">?view=jason</code>{' '}
          (default), <code className="rounded bg-zinc-900 px-1">?view=va</code>,
          or <code className="rounded bg-zinc-900 px-1">?view=partner</code> to
          any Drive or Solutions URL to filter what's visible. Folder-level{' '}
          <code className="rounded bg-zinc-900 px-1">audience:</code> tags in
          the vault are curator-controlled.
        </p>
        <div className="grid grid-cols-1 gap-2 text-xs md:grid-cols-3">
          <div className="rounded border border-zinc-800 bg-zinc-900 p-2">
            <strong className="text-text-primary">view=jason</strong> -- sees
            everything. The default for Jason and Carlos.
          </div>
          <div className="rounded border border-zinc-800 bg-zinc-900 p-2">
            <strong className="text-text-primary">view=va</strong> -- sees{' '}
            <em>all</em> + <em>internal</em>. For Louise, James, Trisha,
            Vincent, Ed.
          </div>
          <div className="rounded border border-zinc-800 bg-zinc-900 p-2">
            <strong className="text-text-primary">view=partner</strong> -- sees{' '}
            <em>all</em> + <em>partner-only</em>. For strategic partners on
            specific portals.
          </div>
        </div>
      </div>

      {/* Primary surfaces */}
      <div>
        <h2 className="mb-3 text-base font-semibold text-text-primary">
          Primary surfaces
        </h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          <Card
            to="/drive"
            icon={HardDrive}
            title="Drive"
            description="19 folders, 180 files from the PMC Assets Google Drive. Hourly snapshot via cron; live hot-reload on vault edits."
            badge="live"
          />
          <Card
            to="/solutions"
            icon={Briefcase}
            title="Solutions & Partners"
            description="MedVectis, Quicksilver, Weave, CMPSE, PLAUD, AccuFit, EarthFirst, ThinkSgink. Third-party solutions Jason represents or integrates."
            badge="live"
          />
          <Card
            to="/contacts"
            icon={Users}
            title="Contacts"
            description="Team + clinical partners + prospects. Pulled from the vault contacts directory."
            badge="live"
          />
        </div>
      </div>

      {/* PMC sub-brands */}
      <div>
        <h2 className="mb-1 text-base font-semibold text-text-primary">
          PMC sub-brands
        </h2>
        <p className="mb-3 text-xs text-text-tertiary">
          Entities Jason owns and operates. The PMC umbrella holds all of these.
        </p>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Card to="/pmc" icon={Briefcase} title="PMC" description="Parent advisory consultancy." />
          <Card to="/brt" icon={BarChart2} title="BRT (BioReg)" description="Clinical PEMF + EEG biofeedback. bioreg.us." />
          <Card to="/tts" icon={Volume2} title="TTS" description="Therapeutic Technology Showcase. June 27 closed-door." />
          <Card to="/ihht" icon={Activity} title="IHHT" description="Intermittent Hypoxia-Hyperoxia Therapy program." />
          <Card to="/qep" icon={ClipboardList} title="QEP" description="Quantum Executive Protocol -- The Fountain venue." />
          <Card to="/sg-ink" icon={PenLine} title="SG INK" description="SG INK content brand." />
          <Card to="/social-content" icon={Share2} title="Social Content" description="Cross-brand content engine including bioreg.tech IG audience layer." />
        </div>
      </div>

      {/* Operating-lens categories */}
      <div>
        <h2 className="mb-3 text-base font-semibold text-text-primary">
          Operating-lens categories
        </h2>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Card to="/category/writing-comms" icon={Mail} title="Writing" description="Outbound comms, drafts, voice." />
          <Card to="/category/research-learning" icon={FlaskConical} title="Research" description="Briefs, market intel, decision memos." />
          <Card to="/category/techbase" icon={Wrench} title="Techbase" description="Tools, infra, integrations." />
          <Card to="/category/work-daily-ops" icon={CheckSquare} title="Daily Ops" description="Tasks, this-week, blockers." />
        </div>
      </div>

      {/* Quick orientation */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 text-xs">
        <h2 className="mb-2 text-base font-semibold text-text-primary">
          Where things live
        </h2>
        <ul className="space-y-1.5 text-text-secondary">
          <li>
            <strong className="text-text-primary">Vault source of truth:</strong>{' '}
            <code className="text-text-tertiary">gbauto/jid5274</code> on GitHub
            (every commit is pushed; this dashboard reads from it).
          </li>
          <li>
            <strong className="text-text-primary">PMC sub-brands:</strong>{' '}
            <code className="text-text-tertiary">businesses/pmc/</code>
          </li>
          <li>
            <strong className="text-text-primary">Solutions & Partners:</strong>{' '}
            <code className="text-text-tertiary">partners/</code>
          </li>
          <li>
            <strong className="text-text-primary">Client engagements:</strong>{' '}
            <code className="text-text-tertiary">clients-engagements/</code>{' '}
            (Cleveland Clinic, Precision Health, ...)
          </li>
          <li>
            <strong className="text-text-primary">Decisions / ADRs:</strong>{' '}
            <code className="text-text-tertiary">intelligence/decisions/</code>
          </li>
          <li>
            <strong className="text-text-primary">Escalations to Greg:</strong>{' '}
            <code className="text-text-tertiary">intelligence/escalations/</code>
          </li>
        </ul>
      </div>

      <p className="text-[11px] text-text-tertiary">
        Edit any markdown file in the vault and this dashboard refreshes within
        ~2s (Vite hot-reload). Hourly cron syncs Google Drive metadata.
      </p>
    </div>
  );
}
