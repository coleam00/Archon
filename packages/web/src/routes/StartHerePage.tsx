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
  Share2,
  Megaphone,
  Sparkles,
  Target,
} from 'lucide-react';
import driveIndex from '@/lib/drive-index.generated.json';
import solutionsData from '@/lib/solutions.generated.json';
import contactsData from '@/lib/contacts.generated.json';
import localOperatorData from '@/lib/ttts-local-operators.generated.json';
import { isContactStub } from '@/lib/contact-utils';

interface CardProps {
  to: string;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
}

interface DriveFolderSnapshot {
  fileCount?: number;
}

interface SolutionSnapshot {
  name?: string;
}

interface ContactSnapshot {
  email?: string;
  role?: string;
}

function safeCount(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function Card({ to, title, description, icon: Icon, badge }: CardProps): React.ReactElement {
  return (
    <Link
      to={to}
      className="group flex flex-col gap-2 rounded-lg border border-border bg-surface-elevated p-4 transition-colors hover:border-border-bright hover:bg-surface-hover"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-text-secondary" />
          <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        </div>
        {badge && (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
            {badge}
          </span>
        )}
      </div>
      <p className="text-xs text-text-secondary">{description}</p>
    </Link>
  );
}

export function StartHerePage(): React.ReactElement {
  // Live counts from generated JSON (refreshed by build script + cron syncs).
  // Defensive: tolerate partial snapshots where a generator emits a non-array value.
  const drivePayload = driveIndex as { count?: unknown; folders?: unknown };
  const solutionsPayload = solutionsData as { count?: unknown; solutions?: unknown };
  const contactsPayload = contactsData as { contacts?: unknown };
  const localOperatorPayload = localOperatorData as {
    totals?: { included?: unknown };
    operators?: unknown;
  };
  const driveFolders = (Array.isArray(drivePayload.folders) ? drivePayload.folders : []).filter(
    (folder): folder is DriveFolderSnapshot => typeof folder === 'object' && folder !== null
  );
  const solutions = (
    Array.isArray(solutionsPayload.solutions) ? solutionsPayload.solutions : []
  ).filter(
    (solution): solution is SolutionSnapshot => typeof solution === 'object' && solution !== null
  );
  const contacts = (Array.isArray(contactsPayload.contacts) ? contactsPayload.contacts : []).filter(
    (contact): contact is ContactSnapshot => typeof contact === 'object' && contact !== null
  );

  const driveFolderCount = safeCount(drivePayload.count, driveFolders.length);
  const driveFileCount = driveFolders.reduce((acc, f) => acc + safeCount(f.fileCount, 0), 0);
  const solutionsCount = safeCount(solutionsPayload.count, solutions.length);
  const solutionsNames = solutions
    .map(s => (s.name ?? '').replace(/\s*\(.*?\)\s*/g, '').trim())
    .filter(Boolean)
    .join(', ');
  // Filter out TBD-stub contacts the same way ContactsPage does so the count matches
  const realContactsCount = contacts.filter(c => !isContactStub(c)).length;
  const localOperatorRows = Array.isArray(localOperatorPayload.operators)
    ? localOperatorPayload.operators
    : [];
  const localOperatorCount = safeCount(
    localOperatorPayload.totals?.included,
    localOperatorRows.length
  );
  const solutionsDescription = solutionsNames
    ? `${solutionsCount} third-party solutions Jason represents or integrates: ${solutionsNames}.`
    : `${solutionsCount} third-party solutions Jason represents or integrates. Awaiting solutions snapshot names.`;

  return (
    <div className="flex h-full flex-1 flex-col gap-6 overflow-y-auto p-6">
      {/* Hero */}
      <div className="flex flex-col gap-2">
        <h1
          className="text-3xl font-semibold text-text-primary"
          style={{ fontFamily: "'Playfair Display', serif" }}
        >
          Welcome
        </h1>
        <p className="text-sm text-text-secondary">
          This is Jason Diaz's operations dashboard -- a single surface for the PMC portfolio,
          partner / solution catalog, Google Drive index, contacts, and live engagement state. Built
          to keep the team aligned and moving.
        </p>
        <div className="flex flex-wrap items-center gap-3 text-xs text-text-tertiary">
          <span>Single KPI:</span>
          <span className="rounded-full border border-emerald-700/40 bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800">
            first meetings booked / week
          </span>
          <span>Day-30 target: 8/wk · Day-90 target: 15/wk</span>
        </div>
      </div>

      {/* Three audience views explainer */}
      <div className="rounded-lg border border-border bg-surface-elevated p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-text-primary">Audience view</h2>
          <span className="text-[10px] uppercase tracking-wider text-text-tertiary">
            Switches visibility across Drive &amp; Solutions
          </span>
        </div>
        <div className="grid grid-cols-1 gap-2 text-xs md:grid-cols-3">
          <a
            href="?view=jason"
            className="group rounded-md border border-border bg-surface-inset p-3 transition-all hover:border-primary/60 hover:shadow-sm"
          >
            <div className="flex items-center justify-between">
              <strong className="text-sm text-text-primary">Jason</strong>
              <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                default
              </span>
            </div>
            <p className="mt-1 text-text-secondary">
              Sees everything. The operator view for Jason and Carlos.
            </p>
          </a>
          <a
            href="?view=va"
            className="group rounded-md border border-border bg-surface-inset p-3 transition-all hover:border-primary/60 hover:shadow-sm"
          >
            <div className="flex items-center justify-between">
              <strong className="text-sm text-text-primary">VA team</strong>
              <span className="rounded-full border border-amber-700/40 bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                internal
              </span>
            </div>
            <p className="mt-1 text-text-secondary">
              Sees all + internal. For Louise, James, Trisha, Vincent, Ed.
            </p>
          </a>
          <a
            href="?view=partner"
            className="group rounded-md border border-border bg-surface-inset p-3 transition-all hover:border-primary/60 hover:shadow-sm"
          >
            <div className="flex items-center justify-between">
              <strong className="text-sm text-text-primary">Strategic partner</strong>
              <span className="rounded-full border border-emerald-700/40 bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
                external
              </span>
            </div>
            <p className="mt-1 text-text-secondary">
              Sees all + partner-only. Cleaned of internal context for outside meetings.
            </p>
          </a>
        </div>
      </div>

      {/* Primary surfaces */}
      <div>
        <h2 className="mb-3 text-base font-semibold text-text-primary">Primary surfaces</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          <Card
            to="/drive"
            icon={HardDrive}
            title="Drive"
            description={`${driveFolderCount} folders, ${driveFileCount} files from the PMC Assets Google Drive. Hourly snapshot via cron; live hot-reload on vault edits.`}
            badge="live"
          />
          <Card
            to="/solutions"
            icon={Briefcase}
            title="Solutions & Partners"
            description={solutionsDescription}
            badge="live"
          />
          <Card
            to="/contacts"
            icon={Users}
            title="Contacts"
            description={`${realContactsCount} people across the team + clinical partners + prospects. Pulled from the vault contacts directory.`}
            badge="live"
          />
        </div>
      </div>

      {/* PMC sub-brands */}
      <div>
        <h2 className="mb-1 text-base font-semibold text-text-primary">PMC sub-brands</h2>
        <p className="mb-3 text-xs text-text-tertiary">
          Entities Jason owns and operates. The PMC umbrella holds all of these.
        </p>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Card to="/pmc" icon={Briefcase} title="PMC" description="Parent advisory consultancy." />
          <Card
            to="/brt"
            icon={BarChart2}
            title="BRT (BioReg)"
            description="Clinical PEMF + EEG biofeedback. bioreg.us."
          />
          <Card
            to="/ttts"
            icon={Volume2}
            title="TTTS"
            description="Therapeutic Technology Showcase. June 27 closed-door Sarasota session."
          />
          <Card
            to="/ttts-local-operators"
            icon={Target}
            title="TTTS Local Operators"
            description="Deduped health/wellness operator list from HeyReach, LinkedIn, dialer, Instagram-evidence rows, and event summary."
            badge={localOperatorCount.toLocaleString()}
          />
          <Card
            to="/ewc"
            icon={Sparkles}
            title="EWC"
            description="Jason's personal LLC -- Lumnen Clinical Partner Program live; online-store build pending. jid5274.gbautomation.xyz."
          />
          <Card
            to="/fountain"
            icon={ClipboardList}
            title="Fountain WPB / QEP"
            description="Boutique anti-aging venue + QEP health-data-governance pilot. WPB."
          />
          <Card
            to="/ihht"
            icon={Activity}
            title="IHHT"
            description="Intermittent Hypoxia-Hyperoxia Therapy program."
          />
          <Card
            to="/accufit"
            icon={Wrench}
            title="AccuFit"
            description="Partner integration tab — AccuFit channel program."
          />
          <Card
            to="/social-content"
            icon={Share2}
            title="VA Workspace"
            description="Active campaigns, sequences, brand voice, and canon for the VA team."
          />
        </div>
      </div>

      {/* External-rep engagements (Jason as 1099 outside sales for non-PMC principals) */}
      <div>
        <h2 className="mb-1 text-base font-semibold text-text-primary">External Reps</h2>
        <p className="mb-3 text-xs text-text-tertiary">
          Engagements where Jason sells someone else's product as a 1099 contractor. Not PMC
          sub-brands. Comp routes to Elevated Wellness LLC.
        </p>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Card
            to="/external-reps/arc"
            icon={Megaphone}
            title="ARC Brand Agency"
            description="Adam Riley -- Google Ads / PPC for European luxury auto. 60-day trial through 2026-07-31."
          />
          <Card
            to="/external-reps/sadn"
            icon={Sparkles}
            title="SADN 2026"
            description="Susan Szantosi -- partner outreach for Sarasota Art & Dance Night, Nov 15 at Art Ovation Hotel."
          />
        </div>
      </div>

      {/* Operating-lens categories */}
      <div>
        <h2 className="mb-3 text-base font-semibold text-text-primary">
          Operating-lens categories
        </h2>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Card
            to="/category/writing-comms"
            icon={Mail}
            title="Writing"
            description="Outbound comms, drafts, voice."
          />
          <Card
            to="/category/research-learning"
            icon={FlaskConical}
            title="Research"
            description="Briefs, market intel, decision memos."
          />
          <Card
            to="/category/techbase"
            icon={Wrench}
            title="Techbase"
            description="Tools, infra, integrations."
          />
          <Card
            to="/category/work-daily-ops"
            icon={CheckSquare}
            title="Daily Ops"
            description="Tasks, this-week, blockers."
          />
        </div>
      </div>

      {/* Quick orientation */}
      <div className="rounded-lg border border-border bg-surface-elevated p-4 text-xs">
        <h2 className="mb-2 text-base font-semibold text-text-primary">Where things live</h2>
        <ul className="space-y-1.5 text-text-secondary">
          <li>
            <strong className="text-text-primary">Vault source of truth:</strong>{' '}
            <code className="rounded bg-surface-inset px-1 font-mono text-text-primary">
              gbauto/jid5274
            </code>{' '}
            on GitHub (every commit is pushed; this dashboard reads from it).
          </li>
          <li>
            <strong className="text-text-primary">PMC sub-brands:</strong>{' '}
            <code className="rounded bg-surface-inset px-1 font-mono text-text-primary">
              businesses/pmc/
            </code>
          </li>
          <li>
            <strong className="text-text-primary">Solutions & Partners:</strong>{' '}
            <code className="rounded bg-surface-inset px-1 font-mono text-text-primary">
              partners/
            </code>
          </li>
          <li>
            <strong className="text-text-primary">Client engagements:</strong>{' '}
            <code className="rounded bg-surface-inset px-1 font-mono text-text-primary">
              clients-engagements/
            </code>{' '}
            (Cleveland Clinic, Precision Health, ...)
          </li>
          <li>
            <strong className="text-text-primary">Decisions / ADRs:</strong>{' '}
            <code className="rounded bg-surface-inset px-1 font-mono text-text-primary">
              intelligence/decisions/
            </code>
          </li>
          <li>
            <strong className="text-text-primary">Escalations to Greg:</strong>{' '}
            <code className="rounded bg-surface-inset px-1 font-mono text-text-primary">
              intelligence/escalations/
            </code>
          </li>
        </ul>
      </div>

      <p className="text-[11px] text-text-tertiary">
        Edit any markdown file in the vault and this dashboard refreshes within ~2s (Vite
        hot-reload). Hourly cron syncs Google Drive metadata.
      </p>
    </div>
  );
}
