import { Link } from 'react-router';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { parseFrontmatter } from '@/lib/pmc-frontmatter';

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS = [rehypeHighlight];

export interface ProspectChannelMessage {
  /** Display label for the channel (Apollo email, LinkedIn DM, SMS) */
  channel: string;
  /** Optional subject/preview line */
  subject?: string;
  /** Optional last-touch date (YYYY-MM-DD) */
  date?: string;
  /** Direction of the message */
  direction?: 'outbound' | 'inbound';
}

export interface BusinessProspect {
  name: string;
  title?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedin_url?: string | null;
  /** Where this person came from (Apollo campaign / referral / SADN list / etc) */
  source_campaign?: string;
  /** Channel currently being used (Apollo email, LinkedIn DM, direct, etc) */
  channel?: string;
  /** Stage descriptor — "Replied", "Warm", "Cold", "Key contact" */
  tier?: string;
  /** Engagement status string */
  engagement?: string;
  /** Notes — strategy, context, next move */
  notes?: string;
  /** Optional Apollo / HeyReach record ID */
  apollo_id?: string;
  /** Optional category label (used for SADN — wellness, medspa, etc) */
  category?: string;
  /** Optional ask label (used for SADN) */
  ask?: string;
  /** Optional message history (for prospects with multi-touch threads) */
  messages?: ProspectChannelMessage[];
}

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
  /** Optional value-prop tiles rendered above the overview (concise pitch) */
  valueProps?: { title: string; body: string }[];
  /** Optional sub-sections rendered after the overview body */
  sections?: BusinessSection[];
  /** Optional top-prospects rendered as a contact card grid */
  prospects?: BusinessProspect[];
  /** Optional label for the prospects section heading */
  prospectsHeading?: string;
  /** Optional sub-label for the prospects section */
  prospectsSubtitle?: string;
  /** Vault path footer */
  vaultPath: string;
}

// Ivory-canvas badge palette — light tints with dark text for readability on the
// jid5274 dashboard's beige background. Previously bg-*-900/40 text-*-300 (dark theme)
// which rendered as muddy boxes on the ivory canvas. See 2026-06-04 contrast pass +
// dashboard-improvement-log entry C:BusinessPage badges.
const BADGE_STYLE: Record<NonNullable<BusinessSubItem['badgeTone']>, string> = {
  emerald: 'bg-emerald-100 text-emerald-800 border-emerald-700/40',
  amber: 'bg-amber-100 text-amber-800 border-amber-700/40',
  sky: 'bg-sky-100 text-sky-800 border-sky-700/40',
  rose: 'bg-rose-100 text-rose-800 border-rose-700/40',
  zinc: 'bg-surface-inset text-text-secondary border-border',
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
  valueProps,
  sections = [],
  prospects,
  prospectsHeading = 'Top prospects',
  prospectsSubtitle,
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

        {tagline && <p className="text-sm text-text-secondary">{tagline}</p>}

        {/* KPI strip */}
        {kpis && kpis.length > 0 && (
          <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {kpis.map(k => (
              <div key={k.label} className="rounded-lg border border-border bg-surface p-3">
                <div className="text-[10px] uppercase tracking-wider text-text-tertiary">
                  {k.label}
                </div>
                <div className="mt-1 text-lg font-semibold text-text-primary">{k.value}</div>
              </div>
            ))}
          </section>
        )}

        {/* Value props — pitch tiles */}
        {valueProps && valueProps.length > 0 && (
          <section className="grid gap-3 md:grid-cols-3">
            {valueProps.map(v => (
              <div key={v.title} className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                <div className="text-xs font-semibold uppercase tracking-wider text-primary">
                  {v.title}
                </div>
                <div className="mt-2 text-sm text-text-primary">{v.body}</div>
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
            <h2 className="mb-3 text-sm font-semibold text-text-primary">{sec.heading}</h2>
            {sec.items.length === 0 ? (
              <p className="text-xs text-text-tertiary">No items yet.</p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {sec.items.map((item, idx) => {
                  const inner = (
                    <article className="rounded-lg border border-border bg-surface p-4 transition-colors hover:border-primary/40">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-sm font-medium text-text-primary">{item.title}</h3>
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
                        <p className="mt-1 text-xs text-text-secondary">{item.description}</p>
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
                  return <div key={item.slug ?? `${sec.heading}-${idx}`}>{inner}</div>;
                })}
              </div>
            )}
          </section>
        ))}

        {/* Top prospects — contact card grid */}
        {prospects && prospects.length > 0 && (
          <section>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-text-primary">{prospectsHeading}</h2>
              <span className="text-[10px] text-text-tertiary">
                {prospectsSubtitle ??
                  `${prospects.length} contact${prospects.length === 1 ? '' : 's'}`}
              </span>
            </div>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {prospects.map((p, idx) => (
                <article
                  key={`${p.name}-${idx}`}
                  className="rounded-lg border border-border bg-surface p-4 transition-colors hover:border-primary/40"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-medium text-text-primary">{p.name}</h3>
                      {p.title && (
                        <p className="mt-0.5 truncate text-xs text-text-secondary">{p.title}</p>
                      )}
                      {p.company && (
                        <p className="mt-0.5 truncate text-xs text-text-tertiary">{p.company}</p>
                      )}
                    </div>
                    {p.tier && (
                      <span
                        className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                          p.tier.toLowerCase().includes('warm') ||
                          p.tier.toLowerCase().includes('replied') ||
                          p.tier.toLowerCase().includes('key')
                            ? BADGE_STYLE.emerald
                            : p.tier.toLowerCase().includes('cold') ||
                                p.tier.toLowerCase().includes('pending')
                              ? BADGE_STYLE.amber
                              : BADGE_STYLE.sky
                        }`}
                      >
                        {p.tier}
                      </span>
                    )}
                  </div>

                  {/* Contact links */}
                  {(p.email || p.phone || p.linkedin_url) && (
                    <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                      {p.email && (
                        <a href={`mailto:${p.email}`} className="text-primary hover:underline">
                          ✉ {p.email.length > 30 ? p.email.slice(0, 28) + '…' : p.email}
                        </a>
                      )}
                      {p.phone && (
                        <a
                          href={`tel:${p.phone.replace(/[^+0-9]/g, '')}`}
                          className="text-primary hover:underline"
                        >
                          ☏ {p.phone}
                        </a>
                      )}
                      {p.linkedin_url && (
                        <a
                          href={p.linkedin_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          in/LinkedIn
                        </a>
                      )}
                    </div>
                  )}

                  {/* Channel + source */}
                  {(p.channel || p.source_campaign) && (
                    <div className="mt-2 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-text-tertiary">
                      {p.channel && <span>📡 {p.channel}</span>}
                      {p.source_campaign && (
                        <span>
                          ·{' '}
                          {p.source_campaign.length > 32
                            ? p.source_campaign.slice(0, 30) + '…'
                            : p.source_campaign}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Engagement label */}
                  {p.engagement && (
                    <div className="mt-2 text-[10px] uppercase tracking-wider text-emerald-700">
                      {p.engagement}
                    </div>
                  )}

                  {/* Notes */}
                  {p.notes && <p className="mt-2 text-xs italic text-text-secondary">{p.notes}</p>}

                  {/* Category + ask (SADN/sponsor pattern) */}
                  {(p.category || p.ask) && (
                    <div className="mt-2 flex flex-wrap gap-x-2 text-[10px] text-text-tertiary">
                      {p.category && <span>{p.category}</span>}
                      {p.ask && <span>· Ask: {p.ask}</span>}
                    </div>
                  )}

                  {/* Message history */}
                  {p.messages && p.messages.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-text-tertiary">
                        {p.messages.length} message{p.messages.length === 1 ? '' : 's'}
                      </summary>
                      <ul className="mt-2 space-y-1">
                        {p.messages.map((m, mi) => (
                          <li
                            key={mi}
                            className="rounded border border-border bg-bg p-2 text-[11px]"
                          >
                            <div className="flex justify-between text-text-tertiary">
                              <span>
                                {m.direction === 'inbound' ? '⬅ ' : '➡ '}
                                {m.channel}
                              </span>
                              {m.date && <span>{m.date}</span>}
                            </div>
                            {m.subject && (
                              <div className="mt-1 text-text-secondary">{m.subject}</div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}

        {/* Vault path footer */}
        <footer className="border-t border-border pt-4 text-[10px] text-text-tertiary">
          Source: <code className="font-mono">{vaultPath}</code> · Edit in Obsidian, save, dashboard
          hot-reloads.
        </footer>
      </div>
    </div>
  );
}
