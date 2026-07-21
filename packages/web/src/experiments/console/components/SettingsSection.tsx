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
    <section className="rounded-[15px] border border-border bg-surface px-6 py-[22px]">
      <h2 className="mb-[18px] text-base font-extrabold tracking-[-0.2px] text-text-primary">
        {title}
      </h2>
      {children}
    </section>
  );
}
