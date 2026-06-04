import { useMemo, useState } from 'react';
import {
  Search,
  Mail,
  Linkedin,
  Phone,
  ExternalLink,
  Users,
  Stethoscope,
  UserPlus,
} from 'lucide-react';
import contactsData from '@/lib/contacts.generated.json';

interface Contact {
  id: string;
  slug: string;
  category: 'team' | 'clinical-partners' | 'prospects';
  name: string;
  role: string;
  company: string;
  email: string;
  linkedin: string;
  phone: string;
  status: string;
  preview: string;
  tags: string[];
  vaultPath: string;
}

const CATEGORIES: {
  slug: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
}[] = [
  { slug: 'all', label: 'All', icon: Users, description: 'Everyone in the directory.' },
  {
    slug: 'team',
    label: 'Team',
    icon: Users,
    description: "Jason's team and strategic partners. VAs, PMs, principals.",
  },
  {
    slug: 'clinical-partners',
    label: 'Clinical Partners',
    icon: Stethoscope,
    description:
      'Doctors and clinical practitioners who provide demos, case studies, or partnership.',
  },
  {
    slug: 'prospects',
    label: 'Prospects',
    icon: UserPlus,
    description: 'Sales prospects across PMC and BRT pipelines.',
  },
];

export function ContactsPage(): React.ReactElement {
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [search, setSearch] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const allContacts = useMemo<Contact[]>(() => {
    const raw = (contactsData.contacts as Contact[]) ?? [];
    // Filter vault stubs — contacts with TBD role/email are placeholders pending
    // Jason confirmation, not real records. Surface them only via /contacts?include=stubs.
    return raw.filter(c => {
      const isStub = c.email === 'TBD' || (c.role ?? '').trim().toUpperCase().startsWith('TBD');
      return !isStub;
    });
  }, []);

  const filtered = useMemo<Contact[]>(() => {
    const q = search.trim().toLowerCase();
    return allContacts.filter(c => {
      if (activeCategory !== 'all' && c.category !== activeCategory) return false;
      if (!q) return true;
      const haystack = [c.name, c.role, c.company, c.email, c.preview, ...(c.tags ?? [])]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [allContacts, activeCategory, search]);

  const counts = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = { all: allContacts.length };
    for (const c of allContacts) {
      out[c.category] = (out[c.category] ?? 0) + 1;
    }
    return out;
  }, [allContacts]);

  const selected = selectedId ? (allContacts.find(c => c.id === selectedId) ?? null) : null;

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-text-primary">Contacts</h1>
        <p className="text-sm text-text-secondary">
          People across the PMC engagement — team, clinical partners, prospects. Pulled from the
          second-brain vault on every dashboard build.
        </p>
        <p className="text-xs text-text-tertiary">
          {allContacts.length} contacts · last refreshed{' '}
          {new Date(contactsData.generated_at).toLocaleString()}
        </p>
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
          placeholder="Search by name, role, email, company..."
          className="w-full rounded-md border border-border bg-surface-elevated py-2 pl-10 pr-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none"
        />
      </div>

      {/* Category tabs */}
      <div className="flex flex-wrap gap-1 border-b border-border">
        {CATEGORIES.map(cat => {
          const isActive = cat.slug === activeCategory;
          const count = counts[cat.slug] ?? 0;
          // eslint-disable-next-line @typescript-eslint/naming-convention
          const Icon = cat.icon;
          return (
            <button
              key={cat.slug}
              onClick={(): void => {
                setActiveCategory(cat.slug);
              }}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                isActive
                  ? 'border-primary text-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              <Icon className="h-4 w-4" />
              {cat.label}
              <span
                className={`inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                  isActive ? 'bg-primary text-primary-foreground' : 'bg-zinc-800 text-zinc-300'
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Two-pane layout */}
      <div className="grid gap-4 lg:grid-cols-[1fr_minmax(0,400px)]">
        {/* Contact list */}
        <div className="flex flex-col gap-2">
          {filtered.length === 0 ? (
            <div className="rounded-md border border-dashed border-border bg-surface-elevated p-6 text-center">
              <p className="text-sm text-text-secondary">
                No contacts match {search ? `"${search}"` : 'the current filter'}.
              </p>
            </div>
          ) : (
            filtered.map(c => (
              <button
                key={c.id}
                onClick={(): void => {
                  setSelectedId(c.id);
                }}
                className={`flex flex-col gap-1 rounded-md border p-3 text-left transition-colors ${
                  selectedId === c.id
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-surface-elevated hover:border-zinc-600'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-semibold text-text-primary">
                      {c.name}
                    </span>
                    {c.role && (
                      <span className="truncate text-xs text-text-secondary">{c.role}</span>
                    )}
                  </div>
                  <span
                    className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-medium ${
                      c.category === 'team'
                        ? 'bg-blue-950/50 text-blue-300'
                        : c.category === 'clinical-partners'
                          ? 'bg-emerald-950/50 text-emerald-300'
                          : 'bg-amber-950/50 text-amber-300'
                    }`}
                  >
                    {c.category.replace('-', ' ')}
                  </span>
                </div>
                {c.preview && (
                  <p className="line-clamp-2 text-xs text-text-tertiary">{c.preview}</p>
                )}
                <div className="flex flex-wrap items-center gap-3 pt-1 text-[11px] text-text-tertiary">
                  {c.email && (
                    <span className="inline-flex items-center gap-1">
                      <Mail className="h-3 w-3" /> {c.email}
                    </span>
                  )}
                  {c.linkedin && (
                    <span className="inline-flex items-center gap-1">
                      <Linkedin className="h-3 w-3" /> linkedin
                    </span>
                  )}
                  {c.company && <span>· {c.company}</span>}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Detail pane */}
        <div className="lg:sticky lg:top-4 lg:self-start">
          {!selected ? (
            <div className="rounded-md border border-dashed border-border bg-surface-elevated p-6 text-center">
              <p className="text-sm text-text-secondary">Select a contact to see details.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4 rounded-md border border-border bg-surface-elevated p-5">
              <div className="flex flex-col gap-1">
                <h2 className="text-lg font-semibold text-text-primary">{selected.name}</h2>
                {selected.role && <p className="text-sm text-text-secondary">{selected.role}</p>}
                {selected.company && (
                  <p className="text-xs text-text-tertiary">{selected.company}</p>
                )}
              </div>

              <div className="flex flex-col gap-2 border-t border-border pt-3">
                {selected.email && (
                  <a
                    href={`mailto:${selected.email}`}
                    className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
                  >
                    <Mail className="h-4 w-4" />
                    {selected.email}
                  </a>
                )}
                {selected.linkedin && (
                  <a
                    href={
                      selected.linkedin.startsWith('http')
                        ? selected.linkedin
                        : `https://${selected.linkedin}`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
                  >
                    <Linkedin className="h-4 w-4" />
                    LinkedIn <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                {selected.phone && (
                  <span className="inline-flex items-center gap-2 text-sm text-text-secondary">
                    <Phone className="h-4 w-4" />
                    {selected.phone}
                  </span>
                )}
                {!selected.email && !selected.linkedin && !selected.phone && (
                  <p className="text-xs text-text-tertiary">No contact methods recorded yet.</p>
                )}
              </div>

              {selected.preview && (
                <div className="border-t border-border pt-3">
                  <p className="text-sm text-text-secondary">{selected.preview}</p>
                </div>
              )}

              {selected.tags && selected.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 border-t border-border pt-3">
                  {selected.tags.slice(0, 8).map(t => (
                    <span
                      key={t}
                      className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] font-mono text-zinc-400"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}

              <div className="border-t border-border pt-3 text-[11px] text-text-tertiary">
                Source:{' '}
                <code className="rounded bg-zinc-800 px-1 py-0.5">{selected.vaultPath}</code>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
