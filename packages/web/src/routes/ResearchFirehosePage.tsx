import React, { useMemo, useState } from 'react';
import { Sparkles, Copy, Check, Calendar, Tag } from 'lucide-react';

// Vite raw-glob over all dated brief / decision / spec markdown in the vault.
// Pulls everything matching YYYY-MM-DD-*.md in the intelligence subfolders.
const briefModules = import.meta.glob(
  [
    '@second-brain/intelligence/briefs/*.md',
    '@second-brain/intelligence/decisions/*.md',
    '@second-brain/intelligence/specs/*.md',
  ],
  { eager: true, query: '?raw', import: 'default' }
);

interface FirehoseItem {
  path: string;
  filename: string;
  category: 'brief' | 'decision' | 'spec';
  date: string | null;
  title: string;
  description: string;
  tags: string[];
  preview: string;
  charCount: number;
}

function parseFrontmatter(raw: string): { fm: Record<string, string | string[]>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) return { fm: {}, body: raw };
  const fm: Record<string, string | string[]> = {};
  for (const line of match[1].split('\n')) {
    const kv = /^(\w+):\s*(.+)$/.exec(line);
    if (!kv) continue;
    const [, k, v] = kv;
    const trimmed = v.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      fm[k] = trimmed
        .slice(1, -1)
        .split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      fm[k] = trimmed.replace(/^["']|["']$/g, '');
    }
  }
  return { fm, body: match[2] };
}

function categorize(p: string): FirehoseItem['category'] {
  if (p.includes('/decisions/')) return 'decision';
  if (p.includes('/specs/')) return 'spec';
  return 'brief';
}

const ITEMS: FirehoseItem[] = Object.entries(briefModules)
  .map(([path, raw]) => {
    const filename = path.split('/').pop() ?? path;
    const dateMatch = /^(\d{4}-\d{2}-\d{2})/.exec(filename);
    const date = dateMatch ? dateMatch[1] : null;
    const { fm, body } = parseFrontmatter(raw as string);
    const titleFromBody = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
    const title =
      (typeof fm.title === 'string' ? fm.title : undefined) ??
      titleFromBody ??
      filename
        .replace(/\.md$/, '')
        .replace(/^\d{4}-\d{2}-\d{2}-/, '')
        .replace(/-/g, ' ');
    const description = (typeof fm.description === 'string' ? fm.description : undefined) ?? '';
    const tags = Array.isArray(fm.tags) ? fm.tags : [];
    // First non-empty paragraph after frontmatter / heading, truncated
    const cleanBody = body
      .replace(/^#+\s+.+$/gm, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();
    const firstPara = cleanBody.split(/\n\n+/).find(p => p.trim().length > 30) ?? '';
    const preview = firstPara.replace(/\s+/g, ' ').trim().slice(0, 280);
    return {
      path,
      filename,
      category: categorize(path),
      date,
      title,
      description,
      tags,
      preview,
      charCount: cleanBody.length,
    };
  })
  .sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return a.filename.localeCompare(b.filename);
  });

const CATEGORY_LABEL: Record<FirehoseItem['category'], string> = {
  brief: 'Brief',
  decision: 'Decision',
  spec: 'Spec',
};

const CATEGORY_TONE: Record<FirehoseItem['category'], string> = {
  brief: 'border-blue-700/40 bg-blue-100 text-blue-800',
  decision: 'border-emerald-700/40 bg-emerald-100 text-emerald-800',
  spec: 'border-amber-700/40 bg-amber-100 text-amber-800',
};

type Filter = 'all' | FirehoseItem['category'];

export function ResearchFirehosePage(): React.ReactElement {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    let out = ITEMS;
    if (filter !== 'all') out = out.filter(i => i.category === filter);
    if (search.trim()) {
      const q = search.toLowerCase();
      out = out.filter(
        i =>
          i.title.toLowerCase().includes(q) ||
          i.description.toLowerCase().includes(q) ||
          i.preview.toLowerCase().includes(q) ||
          i.tags.some(t => t.toLowerCase().includes(q))
      );
    }
    return out;
  }, [filter, search]);

  const counts = useMemo(
    () => ({
      all: ITEMS.length,
      brief: ITEMS.filter(i => i.category === 'brief').length,
      decision: ITEMS.filter(i => i.category === 'decision').length,
      spec: ITEMS.filter(i => i.category === 'spec').length,
    }),
    []
  );

  // Top 5 most recent by date — the "what to read first" highlight band.
  const featured = ITEMS.slice(0, 5);

  return (
    <div className="flex h-full flex-1 flex-col gap-6 overflow-y-auto p-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <h1
            className="text-3xl font-semibold text-text-primary"
            style={{ fontFamily: "'Playfair Display', serif" }}
          >
            Research Firehose
          </h1>
        </div>
        <p className="text-sm text-text-secondary">
          Editorial digest of every research brief, architecture decision, and spec generated for
          the portfolio. Sorted newest-first. Each entry includes a one-paragraph editorial preview
          so you can scan the implications without opening the file.
        </p>
        <p className="text-xs text-text-tertiary">
          {ITEMS.length} entries indexed. Sources:{' '}
          <code className="rounded bg-surface-inset px-1 font-mono">intelligence/briefs/</code>,{' '}
          <code className="rounded bg-surface-inset px-1 font-mono">intelligence/decisions/</code>,{' '}
          <code className="rounded bg-surface-inset px-1 font-mono">intelligence/specs/</code>.
        </p>
      </div>

      {/* Featured (top 5) */}
      {featured.length > 0 && (
        <div>
          <h2 className="mb-3 text-base font-semibold text-text-primary">
            Most recent · top {featured.length}
          </h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {featured.map(item => (
              <FeaturedCard key={item.path} item={item} />
            ))}
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-elevated p-4">
        <div className="flex flex-wrap items-center gap-2">
          {(['all', 'brief', 'decision', 'spec'] as Filter[]).map(f => (
            <button
              key={f}
              type="button"
              onClick={() => {
                setFilter(f);
              }}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                filter === f
                  ? 'border-primary bg-primary/15 text-primary'
                  : 'border-border bg-surface-inset text-text-secondary hover:border-primary/40'
              }`}
            >
              {f === 'all' ? 'All' : CATEGORY_LABEL[f]} · {counts[f]}
            </button>
          ))}
          <input
            type="text"
            placeholder="Search title, tag, preview…"
            value={search}
            onChange={e => {
              setSearch(e.target.value);
            }}
            className="ml-auto w-full max-w-xs rounded-md border border-border bg-surface-inset px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none md:w-auto"
          />
        </div>
        <p className="text-[10px] text-text-tertiary">
          Showing {filtered.length} of {ITEMS.length} entries. Click the copy icon on any row to
          copy its vault path.
        </p>
      </div>

      {/* Full list */}
      <div className="space-y-2">
        {filtered.map(item => (
          <ListRow key={item.path} item={item} />
        ))}
        {filtered.length === 0 && (
          <div className="rounded-md border border-dashed border-border bg-surface-inset p-6 text-center text-sm text-text-tertiary">
            No entries match the current filter.
          </div>
        )}
      </div>
    </div>
  );
}

function FeaturedCard({ item }: { item: FirehoseItem }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const handleCopy = (): void => {
    void navigator.clipboard
      ?.writeText(`second-brain/${item.path.replace(/^.*?second-brain\//, '')}`)
      .then(() => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 1500);
      });
  };
  return (
    <div className="group flex h-full flex-col gap-2 rounded-lg border border-border bg-card p-4 transition-all hover:border-primary/50 hover:shadow-md">
      <div className="flex items-center justify-between">
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${CATEGORY_TONE[item.category]}`}
        >
          {CATEGORY_LABEL[item.category]}
        </span>
        {item.date && (
          <span className="flex items-center gap-1 text-[10px] text-text-tertiary">
            <Calendar className="h-3 w-3" />
            {item.date}
          </span>
        )}
      </div>
      <h3 className="text-sm font-semibold leading-snug text-text-primary group-hover:text-primary">
        {item.title}
      </h3>
      {item.description && <p className="text-xs italic text-text-secondary">{item.description}</p>}
      {item.preview && <p className="text-xs text-text-tertiary line-clamp-3">{item.preview}</p>}
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
        <code className="rounded bg-surface-inset px-1.5 py-0.5 font-mono text-[10px] text-text-tertiary">
          {item.filename}
        </code>
        <button
          type="button"
          onClick={handleCopy}
          title={copied ? 'Copied!' : `Copy vault path: ${item.path}`}
          className="ml-auto flex items-center gap-1 rounded border border-border bg-surface-inset px-1.5 py-0.5 text-[10px] text-text-tertiary transition-colors hover:border-primary/40 hover:text-primary"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-700" /> : <Copy className="h-3 w-3" />}
          {copied ? 'copied' : 'copy path'}
        </button>
      </div>
    </div>
  );
}

function ListRow({ item }: { item: FirehoseItem }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const handleCopy = (): void => {
    void navigator.clipboard
      ?.writeText(`second-brain/${item.path.replace(/^.*?second-brain\//, '')}`)
      .then(() => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 1500);
      });
  };
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-card p-3 transition-all hover:border-primary/40 hover:shadow-sm">
      <div className="flex items-center gap-3">
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${CATEGORY_TONE[item.category]}`}
        >
          {CATEGORY_LABEL[item.category]}
        </span>
        {item.date && (
          <span className="flex items-center gap-1 text-[10px] text-text-tertiary">
            <Calendar className="h-3 w-3" />
            {item.date}
          </span>
        )}
        <h4 className="flex-1 truncate text-sm font-medium text-text-primary">{item.title}</h4>
        <button
          type="button"
          onClick={handleCopy}
          title={copied ? 'Copied!' : `Copy vault path: ${item.path}`}
          className="flex items-center gap-1 rounded border border-border bg-surface-inset px-1.5 py-0.5 text-[10px] text-text-tertiary transition-colors hover:border-primary/40 hover:text-primary"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-700" /> : <Copy className="h-3 w-3" />}
          {copied ? 'copied' : 'copy path'}
        </button>
      </div>
      {(item.description || item.preview) && (
        <p className="text-xs text-text-secondary line-clamp-2">
          {item.description || item.preview}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <code className="rounded bg-surface-inset px-1.5 py-0.5 font-mono text-[10px] text-text-tertiary">
          {item.filename}
        </code>
        {item.tags.slice(0, 4).map(t => (
          <span
            key={t}
            className="flex items-center gap-1 rounded-full bg-surface-inset px-2 py-0.5 text-[10px] text-text-tertiary"
          >
            <Tag className="h-2.5 w-2.5" />
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}
