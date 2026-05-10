import { Link, useParams } from 'react-router';
import { Briefcase, Folder, Workflow } from 'lucide-react';
import { CATEGORIES, getCategory } from '@/lib/category-content';
import type { CategorySlug } from '@/lib/category-content';

const VAULT_BASE_URL = 'https://github.com/gbauto/jid5274/blob/main/second-brain/';

function vaultLink(path: string): string {
  // Open the vault file/folder in GitHub. Folders just resolve to the tree view.
  return `${VAULT_BASE_URL}${path}`;
}

export function CategoryPage(): React.ReactElement {
  const params = useParams<{ slug?: string }>();
  const slug = (params.slug ?? '') as CategorySlug;

  let category;
  try {
    category = getCategory(slug);
  } catch {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="text-center">
          <h1 className="mb-2 text-xl font-semibold text-text-primary">Category not found</h1>
          <p className="mb-4 text-sm text-text-secondary">
            The category &ldquo;{slug}&rdquo; isn&apos;t recognised.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {CATEGORIES.map(c => (
              <Link
                key={c.slug}
                to={`/category/${c.slug}`}
                className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-text-primary hover:border-primary hover:text-primary"
              >
                {c.emoji} {c.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 space-y-6 overflow-auto p-6">
        {/* Header */}
        <header className="flex items-baseline justify-between">
          <div>
            <h1 className="text-lg font-semibold text-text-primary">
              {category.emoji} {category.label}
            </h1>
            <p className="mt-1 text-xs text-text-secondary">{category.oneLiner}</p>
          </div>
          <span className="text-[10px] uppercase tracking-wide text-text-tertiary">
            Category lens
          </span>
        </header>

        {/* Description */}
        <section className="rounded-lg border border-border bg-surface p-4">
          <p className="text-sm leading-relaxed text-text-primary">{category.description}</p>
        </section>

        {/* Vault sections */}
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Folder className="h-4 w-4" /> Vault sections
          </h2>
          <div className="grid gap-2 md:grid-cols-2">
            {category.vaultSections.map(s => (
              <a
                key={s.path}
                href={vaultLink(s.path)}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex items-center justify-between rounded-md border border-border bg-surface p-3 text-sm text-text-primary transition-colors hover:border-primary hover:bg-surface/80"
              >
                <span className="font-medium">{s.label}</span>
                <code className="text-[11px] text-text-tertiary group-hover:text-primary">
                  {s.path}
                </code>
              </a>
            ))}
          </div>
        </section>

        {/* Workflows in scope */}
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Workflow className="h-4 w-4" /> Workflows in scope
          </h2>
          {category.workflows.length === 0 ? (
            <p className="text-xs text-text-secondary">No workflows assigned yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {category.workflows.map(wf => (
                <a
                  key={wf}
                  href={vaultLink('workflows/workflow-catalog.md')}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-md border border-border bg-surface px-2.5 py-1 font-mono text-xs text-text-secondary hover:border-primary hover:text-primary"
                >
                  {wf}
                </a>
              ))}
            </div>
          )}
          <p className="mt-2 text-[11px] text-text-tertiary">
            Status snapshot:{' '}
            <a
              href={vaultLink('workflows/workflow-catalog.md')}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-primary"
            >
              workflow-catalog.md
            </a>
            {' · '}
            <a
              href={vaultLink('reports/')}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-primary"
            >
              latest detector report
            </a>
          </p>
        </section>

        {/* Quick links into related brand tabs / app pages */}
        {category.quickLinks.length > 0 && (
          <section>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
              <Briefcase className="h-4 w-4" /> Quick links
            </h2>
            <div className="flex flex-wrap gap-2">
              {category.quickLinks.map(link =>
                link.external ? (
                  <a
                    key={link.href}
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-text-primary hover:border-primary hover:text-primary"
                  >
                    {link.label} ↗
                  </a>
                ) : (
                  <Link
                    key={link.href}
                    to={link.href}
                    className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-text-primary hover:border-primary hover:text-primary"
                  >
                    {link.label}
                  </Link>
                )
              )}
            </div>
          </section>
        )}

        {/* Sister categories */}
        <section className="border-t border-border pt-4">
          <h2 className="mb-3 text-[10px] uppercase tracking-wide text-text-tertiary">
            Other categories
          </h2>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.filter(c => c.slug !== slug).map(c => (
              <Link
                key={c.slug}
                to={`/category/${c.slug}`}
                className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-text-secondary hover:border-primary hover:text-primary"
              >
                {c.emoji} {c.shortLabel}
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
