import type { ReactElement, ReactNode } from 'react';

/** Shared card shell for the console settings panels (Assistant, System, …). */
export function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="rounded-console-16 border border-border bg-surface px-6 py-5.5">
      <h2 className="mb-4.5 text-base font-extrabold tracking-console-tight text-text-primary">
        {title}
      </h2>
      {children}
    </section>
  );
}
