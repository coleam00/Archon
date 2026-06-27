import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Search, ExternalLink, Briefcase, CheckCircle2, Eye, Mail, HardDrive } from 'lucide-react';
import solutionsData from '@/lib/solutions.generated.json';
import { STRATEGIC_PARTNERS } from '@/lib/strategic-partners';
import type { StrategicPartnerProfile } from '@/lib/strategic-partners';

type Status = 'active' | 'exploring' | 'prospect' | 'dormant' | '';
type Audience = 'all' | 'internal' | 'partner-only' | 'jason-only';
type UnknownRecord = Record<string, unknown>;

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
  exploring: 'bg-amber-100 text-amber-800 border-amber-700/40',
  prospect: 'bg-sky-100 text-sky-800 border-sky-700/40',
  dormant: 'bg-surface-inset text-text-secondary border-border',
  '': 'bg-surface-inset text-text-secondary border-border',
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function stringField(row: UnknownRecord, key: keyof Solution): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

function normalizeStatus(value: unknown): Status {
  return value === 'active' || value === 'exploring' || value === 'prospect' || value === 'dormant'
    ? value
    : '';
}

function normalizeAudience(value: unknown): Audience {
  return value === 'all' ||
    value === 'internal' ||
    value === 'partner-only' ||
    value === 'jason-only'
    ? value
    : 'jason-only';
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0);
}

function normalizeSolution(row: unknown, index: number): Solution | null {
  if (!isRecord(row)) return null;
  const slug = stringField(row, 'slug') || stringField(row, 'id');
  const name = stringField(row, 'name') || slug;
  if (!slug || !name) return null;
  return {
    id: stringField(row, 'id') || slug,
    slug,
    name,
    type: stringField(row, 'type'),
    category: stringField(row, 'category'),
    model: stringField(row, 'model'),
    status: normalizeStatus(row.status),
    audience: normalizeAudience(row.audience),
    website: stringField(row, 'website'),
    tagline: stringField(row, 'tagline'),
    description: stringField(row, 'description'),
    keyContact: stringField(row, 'keyContact'),
    lastTouch: stringField(row, 'lastTouch'),
    vaultPath: stringField(row, 'vaultPath') || `solutions.generated.json#row-${index + 1}`,
    tags: normalizeTags(row.tags),
  };
}

function strategicPartnerToSolution(partner: (typeof STRATEGIC_PARTNERS)[number]): Solution {
  return {
    id: partner.slug,
    slug: partner.slug,
    name: partner.name,
    type: 'strategic-partner',
    category: 'solution',
    model: partner.category,
    status:
      partner.solutionStatus ?? (partner.slug === 'gapin-peak-launch' ? 'active' : 'exploring'),
    audience: 'all',
    website: partner.links[0]?.url ?? '',
    tagline: partner.positioning,
    description: partner.overview,
    keyContact: '',
    lastTouch: '2026-06-26',
    vaultPath: `archon/packages/web/src/lib/strategic-partners.ts#${partner.slug}`,
    tags: ['strategic-partner', 'research-backed', partner.slug],
  };
}

function isStrategicPartner(slug: string): boolean {
  return STRATEGIC_PARTNERS.some(partner => partner.slug === slug);
}

const PARTNER_CARD_ACCENT: Record<NonNullable<StrategicPartnerProfile['card']>['accent'], string> =
  {
    default: 'border-border bg-surface-elevated hover:border-border hover:bg-surface-hover',
    emerald: 'border-emerald-300 bg-emerald-50/80 hover:border-emerald-400 hover:bg-emerald-50',
    violet: 'border-violet-300 bg-violet-50/80 hover:border-violet-400 hover:bg-violet-50',
    amber: 'border-amber-300 bg-amber-50/80 hover:border-amber-400 hover:bg-amber-50',
    sky: 'border-sky-300 bg-sky-50/80 hover:border-sky-400 hover:bg-sky-50',
    rose: 'border-rose-300 bg-gradient-to-br from-rose-50 via-white to-amber-50 hover:border-rose-400 hover:from-rose-50 hover:to-amber-100/70',
  };

function partnerProfileForSlug(slug: string): StrategicPartnerProfile | undefined {
  return STRATEGIC_PARTNERS.find(partner => partner.slug === slug);
}

function formatTimestamp(iso: string): string {
  if (!iso) return 'never';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString();
}

export function SolutionsPage(): React.ReactElement {
  const [searchParams] = useSearchParams();
  const view = (searchParams.get('view') ?? 'jason').toLowerCase();

  const [search, setSearch] = useState<string>('');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  const solutionsPayload = solutionsData as Partial<{
    generated_at: string;
    solutions: unknown[];
  }>;
  const allSolutions = [
    ...(Array.isArray(solutionsPayload.solutions)
      ? solutionsPayload.solutions
          .map((solution, index) => normalizeSolution(solution, index))
          .filter((solution): solution is Solution => solution !== null)
      : []),
    ...STRATEGIC_PARTNERS.map(strategicPartnerToSolution),
  ];
  const generatedAt = solutionsPayload.generated_at ?? '';

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
          {filtered.map(s => {
            const partner = partnerProfileForSlug(s.slug);
            const card = partner?.card;
            const baseCardStyle = card
              ? PARTNER_CARD_ACCENT[card.accent]
              : 'border-border bg-surface-elevated hover:border-border hover:bg-surface-hover';
            return (
              <button
                key={s.slug}
                type="button"
                onClick={(): void => {
                  setSelectedSlug(s.slug);
                }}
                className={`group relative flex flex-col gap-2 overflow-hidden rounded-lg border p-4 text-left transition-colors ${
                  selected?.slug === s.slug
                    ? 'border-border-bright bg-surface-inset'
                    : baseCardStyle
                }`}
              >
                {card && (
                  <div className="absolute right-0 top-0 h-16 w-16 rounded-bl-full bg-white/60 blur-0" />
                )}
                <div className="relative flex items-start justify-between gap-2">
                  <div>
                    {card && (
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-rose-700">
                        {card.eyebrow}
                      </div>
                    )}
                    <h2 className="text-base font-semibold text-text-primary">{s.name}</h2>
                  </div>
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${STATUS_STYLE[s.status] ?? STATUS_STYLE['']}`}
                  >
                    {s.status || 'tbd'}
                  </span>
                </div>
                {s.tagline && (
                  <p className="relative text-xs text-text-secondary line-clamp-3">{s.tagline}</p>
                )}
                {card && (
                  <div className="relative flex flex-wrap gap-1">
                    {card.highlights.slice(0, 3).map(highlight => (
                      <span
                        key={highlight}
                        className="rounded-full border border-rose-200 bg-white/75 px-2 py-0.5 text-[10px] font-medium text-rose-800"
                      >
                        {highlight}
                      </span>
                    ))}
                  </div>
                )}
                <div className="relative mt-1 flex flex-wrap items-center gap-2 text-[10px] text-text-tertiary">
                  {s.model && (
                    <span className="rounded bg-surface-inset/80 px-1.5 py-0.5">{s.model}</span>
                  )}
                  {s.keyContact && (
                    <span className="inline-flex items-center gap-1">
                      <Mail className="h-3 w-3" /> {s.keyContact}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
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
                      className="inline-flex items-center gap-1 text-blue-700 hover:underline"
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
            {isStrategicPartner(selected.slug) && (
              <Link
                to={`/solutions/${selected.slug}`}
                className="mt-4 inline-flex w-full items-center justify-center rounded-md border border-border bg-surface-inset px-3 py-2 text-xs font-medium text-blue-700 hover:bg-surface-hover"
              >
                Open full research tab
              </Link>
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
        bioreg.tech) live separately under <code>businesses/pmc/</code>. Client engagements
        (Cleveland Clinic, Precision Health) live under <code>clients-engagements/</code>.{' '}
        <HardDrive className="mb-0.5 inline h-3 w-3" /> Drive assets at /drive.
      </p>
    </div>
  );
}
