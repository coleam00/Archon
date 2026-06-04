import overviewRaw from '@second-brain/businesses/pmc/qep/overview.md?raw';
import { BusinessPage } from '@/components/business/BusinessPage';

const VAULT_PATH = 'second-brain/businesses/pmc/qep/overview.md';

const SECTIONS = [
  {
    heading: 'Partnership',
    items: [
      {
        slug: 'fountain',
        title: 'The Fountain (WPB)',
        description: 'QEP partner venue — now a core PMC client',
        to: '/clients/fountain-wpb',
        badge: 'core client',
        badgeTone: 'emerald' as const,
      },
      {
        slug: 'website',
        title: 'quantumexecprotocol.com',
        description: 'Official QEP site',
        href: 'https://quantumexecprotocol.com',
      },
    ],
  },
  {
    heading: 'ICP segments',
    items: [
      {
        slug: 'qep-practitioners',
        title: 'Quantum Energy Practitioners',
        description: 'Bioenergetic-medicine clinicians; emerging-modality early adopters',
      },
      {
        slug: 'functional-med',
        title: 'Functional medicine practices',
        description: 'Adjacent — diagnostic + protocol integration',
      },
      {
        slug: 'wellness-retreats',
        title: 'Wellness retreats',
        description: 'With diagnostic offerings — premium positioning',
      },
    ],
  },
];

const KPIS = [
  { label: 'Status', value: 'Active' },
  { label: 'Anchor venue', value: 'The Fountain WPB' },
  { label: 'Vault depth', value: 'overview only' },
];

export function QEPPage(): React.ReactElement {
  return (
    <BusinessPage
      overviewRaw={overviewRaw}
      fallbackName="QEP — Quantum Executive Protocol"
      statusText="Active"
      statusTone="emerald"
      kpis={KPIS}
      sections={SECTIONS}
      vaultPath={VAULT_PATH}
    />
  );
}
