import { Link, Navigate, useParams } from 'react-router';
import {
  ArrowLeft,
  ExternalLink,
  ShieldCheck,
  Stethoscope,
  Target,
  WalletCards,
} from 'lucide-react';
import { STRATEGIC_PARTNERS, getStrategicPartner } from '@/lib/strategic-partners';

function BulletList({ items }: { items: string[] }): React.ReactElement {
  return (
    <ul className="space-y-2 text-sm text-text-secondary">
      {items.map(item => (
        <li key={item} className="flex gap-2">
          <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="rounded-xl border border-border bg-surface-elevated p-5 shadow-sm">
      <h2 className="mb-3 text-base font-semibold text-text-primary">{title}</h2>
      {children}
    </section>
  );
}

export function StrategicPartnerPage(): React.ReactElement {
  const { slug } = useParams<{ slug: string }>();
  const partner = getStrategicPartner(slug);

  if (!partner) {
    return <Navigate to="/solutions" replace />;
  }

  return (
    <div className="flex h-full flex-1 flex-col gap-5 overflow-y-auto p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          to="/solutions"
          className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-elevated px-3 py-2 text-sm text-text-secondary hover:bg-surface-hover"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Solutions
        </Link>
        <div className="flex flex-wrap gap-2">
          {STRATEGIC_PARTNERS.map(item => (
            <Link
              key={item.slug}
              to={`/solutions/${item.slug}`}
              className={`rounded-full border px-3 py-1 text-xs ${
                item.slug === partner.slug
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-surface-elevated text-text-secondary hover:bg-surface-hover'
              }`}
            >
              {item.name}
            </Link>
          ))}
        </div>
      </div>

      <header className="rounded-2xl border border-border bg-[oklch(0.985_0.012_88)] p-6">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs uppercase tracking-wide text-text-tertiary">
          <span>{partner.category}</span>
          <span className="rounded-full border border-border bg-surface-elevated px-2 py-0.5 text-text-secondary">
            {partner.status}
          </span>
        </div>
        <h1 className="mb-3 text-3xl font-semibold text-text-primary">{partner.name}</h1>
        <p className="max-w-4xl text-base leading-7 text-text-secondary">{partner.positioning}</p>
      </header>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <div className="space-y-5">
          <Section title="Overview">
            <p className="text-sm leading-6 text-text-secondary">{partner.overview}</p>
          </Section>

          <Section title="Best-fit collaboration">
            <BulletList items={partner.bestFit} />
          </Section>

          <div className="grid gap-5 lg:grid-cols-2">
            <Section title="Offering">
              <BulletList items={partner.offering} />
            </Section>
            <Section title="Costs / pricing">
              <BulletList items={partner.costs} />
            </Section>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Section title="Benefits">
              <BulletList items={partner.benefits} />
            </Section>
            <Section title="Market insights">
              <BulletList items={partner.marketInsights} />
            </Section>
          </div>

          <Section title="Clinical evidence / diligence links">
            <div className="grid gap-3 md:grid-cols-2">
              {partner.clinicalEvidence.map(link => (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-border bg-surface-inset p-3 hover:bg-surface-hover"
                >
                  <span className="mb-1 flex items-center gap-2 text-sm font-medium text-blue-700">
                    {link.label} <ExternalLink className="h-3.5 w-3.5" />
                  </span>
                  <span className="block text-xs leading-5 text-text-secondary">{link.note}</span>
                </a>
              ))}
            </div>
          </Section>
        </div>

        <aside className="space-y-5">
          <Section title="Pragmatic read">
            <div className="space-y-3 text-sm text-text-secondary">
              <div className="flex gap-3">
                <Target className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>Use this as a relationship and offer-fit surface, not a hype page.</span>
              </div>
              <div className="flex gap-3">
                <WalletCards className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>
                  Quote only public pricing. Anything else requires direct partner confirmation.
                </span>
              </div>
              <div className="flex gap-3">
                <Stethoscope className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>Keep clinical claims conservative and tied to cited evidence.</span>
              </div>
            </div>
          </Section>

          <Section title="Caveats">
            <BulletList items={partner.caveats} />
          </Section>

          <Section title="Primary links">
            <div className="space-y-2">
              {partner.links.map(link => (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-inset px-3 py-2 text-sm text-blue-700 hover:bg-surface-hover"
                >
                  <span>{link.label}</span>
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              ))}
            </div>
          </Section>

          <div className="rounded-xl border border-amber-300/60 bg-amber-50 p-4 text-xs leading-5 text-amber-900">
            <div className="mb-1 flex items-center gap-2 font-semibold">
              <ShieldCheck className="h-4 w-4" /> Research standard
            </div>
            Public-source dashboard summary. Market-size and vendor-outcome claims are treated as
            directional unless independently validated.
          </div>
        </aside>
      </div>
    </div>
  );
}
