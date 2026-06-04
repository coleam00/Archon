import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { listDashboardRuns } from '@/lib/api';
import { pmcOverview, pmcClients } from '@/lib/pmc-content';
import prospectsData from '@/lib/business-prospects.generated.json';
import type { BusinessProspect } from '@/components/business/BusinessPage';

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS = [rehypeHighlight];

function isPmcScoped(workflowName: string): boolean {
  return workflowName.startsWith('jid5274-') || workflowName.startsWith('pmc-');
}

export function PMCPage(): React.ReactElement {
  const {
    data: runsData,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['pmcRuns'],
    queryFn: () => listDashboardRuns({ limit: 25 }),
    refetchInterval: 15_000,
  });

  const pmcRuns = (runsData?.runs ?? []).filter(r => isPmcScoped(r.workflow_name)).slice(0, 5);

  const businessName = pmcOverview.frontmatter.name ?? 'PMC';

  const pmcProspects: BusinessProspect[] =
    (prospectsData.by_business as Record<string, BusinessProspect[]>).PMC ?? [];

  const VALUE_PROPS = [
    {
      title: 'Grand Slam RCM Audit',
      body: 'Recover 8-15% of leaked revenue from coding/denials/AR-aging gaps. Audit ticket $7.5K-$15K, >70% margin, 30-60d close cycle.',
    },
    {
      title: 'Cash-pay practice transformation',
      body: 'Fractional VP-Sales/BD leadership for clinics pivoting from insurance to concierge/DPC/cash-pay. Proven playbook + outbound systems.',
    },
    {
      title: 'Portfolio cross-sell',
      body: 'PMC engagement opens BRT/EWC/Fountain/AccuFit upsell paths. Single advisory contract becomes multi-line revenue stream.',
    },
  ];

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-auto p-6 space-y-6">
        <header className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold text-text-primary">{businessName}</h1>
          {pmcOverview.frontmatter.website && (
            <a
              href={`https://${pmcOverview.frontmatter.website}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline"
            >
              {pmcOverview.frontmatter.website}
            </a>
          )}
        </header>

        <section className="chat-markdown max-w-none text-sm text-text-primary">
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
            {pmcOverview.body}
          </ReactMarkdown>
        </section>

        {/* Value props */}
        <section className="grid gap-3 md:grid-cols-3">
          {VALUE_PROPS.map(v => (
            <div
              key={v.title}
              className="rounded-lg border border-primary/30 bg-primary/5 p-4"
            >
              <div className="text-xs font-semibold uppercase tracking-wider text-primary">
                {v.title}
              </div>
              <div className="mt-2 text-sm text-text-primary">{v.body}</div>
            </div>
          ))}
        </section>

        {/* Top prospects — PMC ICP Apollo engaged contacts */}
        {pmcProspects.length > 0 && (
          <section>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-text-primary">
                Top prospects — PMC ICP engaged
              </h2>
              <span className="text-[10px] text-text-tertiary">
                {pmcProspects.length} contacts · Apollo replied filter
              </span>
            </div>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {pmcProspects.map((p, idx) => (
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
                      <span className="shrink-0 rounded-md border border-emerald-700/40 bg-emerald-900/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-300">
                        {p.tier}
                      </span>
                    )}
                  </div>
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
                  {p.source_campaign && (
                    <div className="mt-2 text-[10px] text-text-tertiary">
                      📡 {p.channel} · {p.source_campaign}
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}

        <section>
          <h2 className="mb-3 text-sm font-semibold text-text-primary">Clients</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {pmcClients.map(client => (
              <article key={client.slug} className="rounded-lg border border-border bg-surface p-4">
                <h3 className="text-sm font-medium text-text-primary">
                  {client.frontmatter.name ?? client.slug}
                </h3>
                {client.frontmatter.status && (
                  <p className="mt-1 text-xs text-text-secondary">
                    Status: {client.frontmatter.status}
                  </p>
                )}
                {client.frontmatter.owner && (
                  <p className="mt-0.5 text-xs text-text-tertiary">
                    Owner: {client.frontmatter.owner}
                  </p>
                )}
              </article>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold text-text-primary">Recent PMC Workflow Runs</h2>
          {isLoading ? (
            <p className="text-xs text-text-tertiary">Loading…</p>
          ) : isError ? (
            <p className="text-xs text-error">Failed to load runs.</p>
          ) : pmcRuns.length === 0 ? (
            <p className="text-xs text-text-tertiary">No PMC-scoped workflow runs yet.</p>
          ) : (
            <ul className="space-y-2">
              {pmcRuns.map(run => (
                <li
                  key={run.id}
                  className="flex items-center justify-between rounded border border-border bg-surface px-3 py-2 text-sm"
                >
                  <Link
                    to={`/workflows/runs/${run.id}`}
                    className="text-text-primary hover:text-primary"
                  >
                    {run.workflow_name}
                  </Link>
                  <span className="text-xs text-text-tertiary">{run.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
