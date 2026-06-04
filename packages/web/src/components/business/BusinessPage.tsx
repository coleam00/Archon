import { Link } from 'react-router';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { parseFrontmatter } from '@/lib/pmc-frontmatter';

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS = [rehypeHighlight];

export interface BusinessSubItem {
  /** Optional slug for the sub-card key */
  slug?: string;
  /** Display label */
  title: string;
  /** Optional small description below the title */
  description?: string;
  /** Optional badge text (e.g. status: active) */
  badge?: string;
  /** Optional badge color tone */
  badgeTone?: 'emerald' | 'amber' | 'sky' | 'rose' | 'zinc';
  /** Optional external URL */
  href?: string;
  /** Optional internal route */
  to?: string;
}

export interface BusinessSection {
  /** Section heading */
  heading: string;
  /** Items rendered as cards in a responsive grid */
  items: BusinessSubItem[];
}

export interface BusinessPageProps {
  /** Raw markdown content (frontmatter + body) imported via ?raw */
  overviewRaw: string;
  /** Fallback display name if frontmatter has none */
  fallbackName: string;
  /** Optional tagline below the H1 (overrides frontmatter description) */
  taglineOverride?: string;
  /** Optional status pill text */
  statusText?: string;
  /** Optional status tone */
  statusTone?: 'emerald' | 'amber' | 'sky' | 'rose' | 'zinc';
  /** Optional KPI strip — rendered as labeled metrics under the header */
  kpis?: { label: string; value: string }[];
  /** Optional sub-sections rendered after the overview body */
  sections?: BusinessSection[];
  /** Vault path footer */
  vaultPath: string;
}

const BADGE_STYLE: Record<NonNullable<BusinessSubItem['badgeTone']>, string> = {
  emerald: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/40',
  amber: 'bg-amber-900/40 text-amber-300 border-amber-700/40',
  sky: 'bg-sky-900/40 text-sky-300 border-sky-700/40',
  rose: 'bg-rose-900/40 text-rose-300 border-rose-700/40',
  zinc: 'bg-zinc-800/40 text-zinc-400 border-zinc-700/40',
};

const STATUS_STYLE: Record<NonNullable<BusinessPageProps['statusTone']>, string> = BADGE_STYLE;

/**
 * Shared layout for per-business tabs (PMC, BRT, EWC, Fountain WPB, IHHT,
 * QEP, SG INK, TTS, etc.). Renders:
 *
 *   header     — name + status pill + website link
 *   kpi strip  — one-glance metrics (optional)
 *   overview   — markdown body of the business's overview.md
 *   sections   — cards organized by sub-section (clients, products, messaging)
 *   footer     — vault-path source label
 *
 * Vault data lives in second-brain/businesses/<...>/overview.md and is
 * imported as ?raw at build time. Edit the .md, save, the dashboard
 * hot-reloads.
 */
export function BusinessPage({
  overviewRaw,
  fallbackName,
  taglineOverride,
  statusText,
  statusTone = 'emerald',
  kpis,
  sections = [],
  vaultPath,
}: BusinessPageProps): React.ReactElement {
  const doc = parseFrontmatter(overviewRaw);
  const name = doc.frontmatter.name ?? doc.frontmatter.title ?? fallbackName;
  const tagline = taglineOverride ?? doc.frontmatter.description ?? '';
  const website = doc.frontmatter.website;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-auto p-6 space-y-6">
        {/* Header */}
        <header className="flex flex-wrap items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-semibold text-text-primary">{name}</h1>
            {statusText && (
              <span
                className={`rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_STYLE[statusTone]}`}
              >
                {statusText}
              </span>
            )}
          </div>
          {website && (
            <a
              href={website.startsWith('http') ? website : `https://${website}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline"
            >
              {website}
            </a>
          )}
        </header>

        {tagline && (
          <p className="text-sm text-text-secondary">{tagline}</p>
        )}

        {/* KPI strip */}
        {kpis && kpis.length > 0 && (
          <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {kpis.map(k => (
              <div
                key={k.label}
                className="rounded-lg border border-border bg-surface p-3"
              >
                <div className="text-[10px] uppercase tracking-wider text-text-tertiary">
                  {k.label}
                </div>
                <div className="mt-1 text-lg font-semibold text-text-primary">
                  {k.value}
                </div>
              </div>
            ))}
          </section>
        )}

        {/* Overview body */}
        {doc.body.trim() && (
          <section className="chat-markdown max-w-none text-sm text-text-primary">
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
              {doc.body}
            </ReactMarkdown>
          </section>
        )}

        {/* Sub-sections */}
        {sections.map(sec => (
          <section key={sec.heading}>
            <h2 className="mb-3 text-sm font-semibold text-text-primary">
              {sec.heading}
            </h2>
            {sec.items.length === 0 ? (
              <p className="text-xs text-text-tertiary">No items yet.</p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {sec.items.map((item, idx) => {
                  const inner = (
                    <article
                      className="rounded-lg border border-border bg-surface p-4 transition-colors hover:border-primary/40"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-sm font-medium text-text-primary">
                          {item.title}
                        </h3>
                        {item.badge && (
                          <span
                            className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                              BADGE_STYLE[item.badgeTone ?? 'zinc']
                            }`}
                          >
                            {item.badge}
                          </span>
                        )}
                      </div>
                      {item.description && (
                        <p className="mt-1 text-xs text-text-secondary">
                          {item.description}
                        </p>
                      )}
                    </article>
                  );
                  if (item.href) {
                    return (
                      <a
                        key={item.slug ?? `${sec.heading}-${idx}`}
                        href={item.href}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {inner}
                      </a>
                    );
                  }
                  if (item.to) {
                    return (
                      <Link key={item.slug ?? `${sec.heading}-${idx}`} to={item.to}>
                        {inner}
                      </Link>
                    );
                  }
                  return (
                    <div key={item.slug ?? `${sec.heading}-${idx}`}>{inner}</div>
                  );
                })}
              </div>
            )}
          </section>
        ))}

        {/* Vault path footer */}
        <footer className="border-t border-border pt-4 text-[10px] text-text-tertiary">
          Source: <code className="font-mono">{vaultPath}</code> · Edit in
          Obsidian, save, dashboard hot-reloads.
        </footer>
      </div>
    </div>
  );
}
