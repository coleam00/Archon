import overviewRaw from '@second-brain/businesses/pmc/bioreg/overview.md?raw';
import { BusinessPage } from '@/components/business/BusinessPage';

const VAULT_PATH = 'second-brain/businesses/pmc/bioreg/overview.md';

const SECTIONS = [
  {
    heading: 'Devices',
    items: [
      {
        slug: 'nesta-pro',
        title: 'Nesta Pro',
        description: 'Recovery + autonomic balance device',
        badge: 'active',
        badgeTone: 'emerald' as const,
      },
      {
        slug: 'cellcom',
        title: 'Cellcom',
        description: 'Flagship cellular optimization device (PEMF + bio-resonance)',
        badge: 'active',
        badgeTone: 'emerald' as const,
      },
      {
        slug: 'pemf',
        title: 'PEMF Modalities',
        description: 'Adjunct PEMF protocols for performance + recovery',
        badge: 'active',
        badgeTone: 'emerald' as const,
      },
    ],
  },
  {
    heading: 'ICP segments',
    items: [
      {
        slug: 'bh-psych',
        title: 'BH-Psych',
        description: '30 active contacts. Behavioral health psychiatry vertical.',
        badge: 'sequence live',
        badgeTone: 'sky' as const,
      },
      {
        slug: 'bh-therapy',
        title: 'BH-Therapy',
        description: '368 active contacts. Behavioral health therapy vertical.',
        badge: 'sequence live',
        badgeTone: 'sky' as const,
      },
      {
        slug: 'chiro',
        title: 'Chiropractic',
        description: '122 active contacts. Maintain mode.',
        badge: 'sequence live',
        badgeTone: 'sky' as const,
      },
      {
        slug: 'medspa',
        title: 'Medspa (Trojan-horse)',
        description: '52 active contacts. Recovery-layer fit, BRT clinical-partner motion.',
        badge: 'sequence live',
        badgeTone: 'sky' as const,
      },
    ],
  },
  {
    heading: 'Programs & assets',
    items: [
      {
        slug: 'cpp',
        title: 'Clinical Partner Program',
        description: 'Co-branded partnership track for clinics adopting BRT devices.',
      },
      {
        slug: 'apollo-sequences',
        title: 'Apollo sequences',
        description: 'BH-Psych, BH-Therapy, Chiro, Medspa — all live with reply triage cron.',
      },
      {
        slug: 'tammy-cut',
        title: 'Tammy Cut HypeReels',
        description: 'Hybrid + uniform reels shipped 6/3.',
      },
    ],
  },
];

const KPIS = [
  { label: 'Active contacts', value: '572' },
  { label: 'Live sequences', value: '4' },
  { label: 'Composite rank', value: '#1 (25/30)' },
  { label: 'First mtg target', value: '25 by mid-Jun' },
];

export function BRTPage(): React.ReactElement {
  return (
    <BusinessPage
      overviewRaw={overviewRaw}
      fallbackName="BRT — BioReg Technologies"
      statusText="Active · Line #1"
      statusTone="emerald"
      kpis={KPIS}
      sections={SECTIONS}
      vaultPath={VAULT_PATH}
    />
  );
}
