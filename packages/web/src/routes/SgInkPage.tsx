import { BusinessPage } from '@/components/business/BusinessPage';

const VAULT_PATH = 'second-brain/businesses/pmc/ (sg-ink folder not yet created)';

const SECTIONS = [
  {
    heading: 'ICP segments',
    items: [
      {
        slug: 'healthcare-founders',
        title: 'Healthcare / wellness founders',
        description: 'Need a content engine: ghostwritten LinkedIn, blogs, thought leadership.',
      },
      {
        slug: 'solo-physicians',
        title: 'Solo medical practice owners',
        description: 'Building personal brand on top of clinical credibility',
      },
      {
        slug: 'coach-consultant',
        title: 'Coach / consultant hybrids',
        description: 'Healthcare or wellness coaches scaling content production',
      },
      {
        slug: 'saas-founders',
        title: 'Healthcare SaaS founders pre-Series A',
        description: 'Building category authority before fundraise',
      },
    ],
  },
  {
    heading: 'Next actions',
    items: [
      {
        slug: 'scaffold-overview',
        title: 'Scaffold businesses/pmc/sg-ink/overview.md',
        description: 'Tab is fully dynamic once the vault file exists.',
        badge: 'pending',
        badgeTone: 'amber' as const,
      },
    ],
  },
];

const KPIS = [
  { label: 'Status', value: 'Stub' },
  { label: 'Vault depth', value: 'missing' },
  { label: 'Apollo prefix', value: 'SGINK' },
];

// SG INK has no overview.md yet — use a placeholder body so BusinessPage
// still renders meaningfully. Replace with ?raw import once the vault
// file is scaffolded.
const PLACEHOLDER = `---
name: SG INK
description: Content engine for healthcare and wellness operators. Ghostwriting + LinkedIn + thought leadership.
---

# SG INK

> **Vault placeholder.** The \`businesses/pmc/sg-ink/overview.md\` file does
> not yet exist. Once scaffolded, this tab will hot-reload from the vault.

SG INK is PMC's content engine for founders and operators in healthcare and
wellness. Service mix: ghostwritten LinkedIn, long-form blogs, thought
leadership pieces, brand-aligned content systems.

See \`lib/brands.ts\` for the canonical ICP definition and the Apollo
sequence prefix (\`[SGINK]\`).
`;

export function SgInkPage(): React.ReactElement {
  return (
    <BusinessPage
      overviewRaw={PLACEHOLDER}
      fallbackName="SG INK"
      statusText="Stub · vault file missing"
      statusTone="amber"
      kpis={KPIS}
      sections={SECTIONS}
      vaultPath={VAULT_PATH}
    />
  );
}
