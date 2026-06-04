import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Search, ExternalLink, Briefcase, CheckCircle2, Eye, Mail, HardDrive } from 'lucide-react';
import solutionsData from '@/lib/solutions.generated.json';

type Status = 'active' | 'exploring' | 'prospect' | 'dormant' | '';
type Audience = 'all' | 'internal' | 'partner-only' | 'jason-only';

interface Solution {
  id: string;
  slug: string;
  name: string;
  type: string;
  category: string;
  model: string;
  status: Status;
  audience: Audience;
  website: string;
  tagline: string;
  description: string;
  keyContact: string;
  lastTouch: string;
  vaultPath: string;
  tags: string[];
}

const VIEW_TO_ALLOWED: Record<string, Set<Audience>> = {
  jason: new Set<Audience>(['all', 'internal', 'partner-only', 'jason-only']),
  va: new Set<Audience>(['all', 'internal']),
  partner: new Set<Audience>(['all', 'partner-only']),
};

function visibleForView(view: string, audience: Audience): boolean {
  const allowed = VIEW_TO_ALLOWED[view] ?? VIEW_TO_ALLOWED.jason;
  return allowed.has(audience);
}

const STATUS_STYLE: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-800 border-emerald-700/40',
  exploring: 'bg-amber-900/40 text-amber-300 border-amber-700/40',
  prospect: 'bg-sky-900/40 text-sky-300 border-sky-700/40',
  dormant: 'bg-surface-inset text-text-secondary border-border',
  '': 'bg-surface-inset text-text-secondary border-border',
};

function formatTimestamp(iso: string): string {
  if (!iso) return 'never';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function SolutionsPage(): React.ReactElement {
  const [searchParams] = useSearchParams();
  const view = (searchParams.get('view') ?? 'jason').toLowerCase();

  const [search, setSearch] = useState<string>('');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  const allSolutions = (solutionsData.solutions as Solution[]) ?? [];
  const generatedAt = (solutionsData as { generated_at?: string }).generated_at ?? '';

  const visibleSolutions = useMemo<Solution[]>(
    () => allSolutions.filter(s => visibleForView(view, s.audience)),
    [allSolutions, view]
  );
  const hiddenCount = allSolutions.length - visibleSolutions.length;

  const filtered = useMemo<Solution[]>(() => {
    const q = search.trim().toLowerCase();
    if (!q) return visibleSolutions;
    return visibleSolutions.filter(s => {
      const hay = [
        s.name,
        s.tagline,
        s.description,
        s.model,
        s.status,
        s.keyContact,
        ...(s.tags ?? []),
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [visibleSolutions, search]);

  const counts = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const s of visibleSolutions) {
      out[s.status] = (out[s.status] ?? 0) + 1;
    }
    return out;
  }, [visibleSolutions]);

  const selected: Solution | null =
    (selectedSlug && visibleSolutions.find(s => s.slug === selectedSlug)) || null;

  return (
    <div className="flex h-full flex-1 flex-col gap-4 p-6">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <Briefcase className="h-6 w-6 text-text-secondary" />
          <h1 className="text-2xl font-semibold text-text-primary">Solutions & Partners</h1>
          <span className="rounded-full bg-surface-inset px-2 py-0.5 text-xs text-text-secondary">
            view: {view}
          </span>
        </div>
        <p className="text-sm text-text-secondary">
          Third-party solutions, distributorships, and strategic partners. Distinct from PMC
          sub-brands (which Jason owns) and clients (orgs Jason serves).
        </p>
        <div className="flex flex-wrap items-center gap-4 text-xs text-text-tertiary">
          <span>last build: {formatTimestamp(generatedAt)}</span>
          <span>
            {visibleSolutions.length} solution
            {visibleSolutions.length === 1 ? '' : 's'}
          </span>
          {Object.entries(counts).map(([status, n]) => (
            <span
              key={status}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${STATUS_STYLE[status] ?? STATUS_STYLE['']}`}
            >
              <CheckCircle2 className="h-3 w-3" /> {status || 'other'}: {n}
            </span>
          ))}
          {hiddenCount > 0 && (
            <span className="inline-flex items-center gap-1 text-text-tertiary">
              <Eye className="h-3 w-3" /> {hiddenCount} hidden by view
            </span>
          )}
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
        <input
          type="search"
          value={search}
          onChange={(e): void => {
            setSearch(e.target.value);
          }}
          placeholder="Search by name, tagline, model, contact..."
          className="w-full rounded-md border border-border bg-surface-inset py-2 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-border-bright focus:outline-none"
        />
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        {/* Cards grid (left/main) */}
        <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-1 gap-3 overflow-y-auto pr-1 md:grid-cols-2 xl:grid-cols-3">
          {filtered.length === 0 && (
            <div className="col-span-full rounded-lg border border-border bg-surface-elevated p-8 text-center text-sm text-text-tertiary">
              No solutions match.
            </div>
          )}
          {filtered.map(s => (
            <button
              key={s.slug}
              type="button"
              onClick={(): void => {
                setSelectedSlug(s.slug);
              }}
              className={`flex flex-col gap-2 rounded-lg border p-4 text-left transition-colors ${
                selected?.slug === s.slug
                  ? 'border-border-bright bg-surface-inset'
                  : 'border-border bg-surface-elevated hover:border-border hover:bg-surface-hover'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-base font-semibold text-text-primary">{s.name}</h2>
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${STATUS_STYLE[s.status] ?? STATUS_STYLE['']}`}
                >
                  {s.status || 'tbd'}
                </span>
              </div>
              {s.tagline && <p className="text-xs text-text-secondary line-clamp-3">{s.tagline}</p>}
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-text-tertiary">
                {s.model && (
                  <span className="rounded bg-surface-inset px-1.5 py-0.5">{s.model}</span>
                )}
                {s.keyContact && (
                  <span className="inline-flex items-center gap-1">
                    <Mail className="h-3 w-3" /> {s.keyContact}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>

        {/* Detail pane (right) */}
        {selected && (
          <div className="w-96 shrink-0 overflow-y-auto rounded-lg border border-border bg-surface-elevated p-4">
            <div className="mb-3 flex items-start justify-between gap-2">
              <h2 className="text-lg font-semibold text-text-primary">{selected.name}</h2>
              <button
                type="button"
                onClick={(): void => {
                  setSelectedSlug(null);
                }}
                className="text-text-tertiary hover:text-text-secondary"
                aria-label="close"
              >
                ✕
              </button>
            </div>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
              <span
                className={`rounded-full border px-2 py-0.5 ${STATUS_STYLE[selected.status] ?? STATUS_STYLE['']}`}
              >
                {selected.status || 'tbd'}
              </span>
              {selected.model && (
                <span className="rounded-full border border-border bg-surface-inset px-2 py-0.5 text-text-secondary">
                  {selected.model}
                </span>
              )}
              <span className="rounded-full border border-border bg-surface-inset px-2 py-0.5 text-text-tertiary">
                audience: {selected.audience}
              </span>
            </div>
            {selected.tagline && (
              <p className="mb-3 text-sm italic text-text-secondary">{selected.tagline}</p>
            )}
            {selected.description && (
              <p className="mb-3 text-sm text-text-secondary">{selected.description}</p>
            )}
            <dl className="mb-3 space-y-1.5 text-xs">
              {selected.keyContact && (
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-text-tertiary">contact</dt>
                  <dd className="text-text-secondary">{selected.keyContact}</dd>
                </div>
              )}
              {selected.lastTouch && (
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-text-tertiary">last touch</dt>
                  <dd className="text-text-secondary">{selected.lastTouch}</dd>
                </div>
              )}
              {selected.website && (
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-text-tertiary">website</dt>
                  <dd>
                    <a
                      href={selected.website}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-blue-400 hover:underline"
                    >
                      {selected.website.replace(/^https?:\/\//, '')}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </dd>
                </div>
              )}
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-text-tertiary">vault</dt>
                <dd className="font-mono text-text-tertiary">{selected.vaultPath}</dd>
              </div>
            </dl>
            {selected.tags && selected.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {selected.tags.map(t => (
                  <span
                    key={t}
                    className="rounded bg-surface-inset px-1.5 py-0.5 text-[10px] text-text-tertiary"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
            <div className="mt-4 border-t border-border pt-3 text-[11px] text-text-tertiary">
              Edit the MOC in the vault at <code>{selected.vaultPath}</code> and this card refreshes
              within ~2s.
            </div>
          </div>
        )}
      </div>

      <p className="text-[11px] text-text-tertiary">
        Sourced from <code>second-brain/partners/</code>. PMC sub-brands (BRT, EWC, TTTS, IHHT, QEP,
        SG INK, bioreg.tech) live separately under <code>businesses/pmc/</code>. Client engagements
        (Cleveland Clinic, Precision Health) live under <code>clients-engagements/</code>.{' '}
        <HardDrive className="mb-0.5 inline h-3 w-3" /> Drive assets at /drive.
      </p>
    </div>
  );
}
