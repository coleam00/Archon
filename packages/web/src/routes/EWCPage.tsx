import overviewRaw from '@second-brain/businesses/pmc/ewc/overview.md?raw';
import { BusinessPage, type BusinessProspect } from '@/components/business/BusinessPage';
import prospectsData from '@/lib/business-prospects.generated.json';

const VAULT_PATH = 'second-brain/businesses/pmc/ewc/overview.md';

const PROSPECTS = (prospectsData.by_business as Record<string, BusinessProspect[]>).EWC ?? [];

const VALUE_PROPS = [
  {
    title: 'Three-pillar premium stack',
    body: 'Wellness products + FDA-cleared Lumnen/Avologi laser + AI practice automation. Sticky multi-line revenue per partner.',
  },
  {
    title: 'Lumnen Clinical Partner Program',
    body: 'Co-branded laser partnership — one-pager and reel shipped, ready for outbound launch to 50-contact pilot list.',
  },
  {
    title: 'Cash-pay practice pivot',
    body: 'Concierge, DPC, medspa, functional med — high-LTV cash-pay practices evaluating premium service+device+automation bundle.',
  },
];

const SECTIONS = [
  {
    heading: 'Three-pillar partnership',
    items: [
      {
        slug: 'wellness-products',
        title: 'Premium wellness products',
        description: 'Curated supplement + product line for cash-pay practices.',
      },
      {
        slug: 'fda-equipment',
        title: 'FDA-cleared equipment (Lumnen / Avologi)',
        description: 'Clinical-grade laser. One-pager + reel shipped.',
        badge: 'asset ready',
        badgeTone: 'emerald' as const,
      },
      {
        slug: 'ai-automation',
        title: 'AI practice automation',
        description: 'PMC + Carlos automations for cash-pay practice transformation.',
      },
    ],
  },
  {
    heading: 'Live assets',
    items: [
      {
        slug: 'aura-landing',
        title: 'Aura landing page',
        description:
          'jid5274.gbautomation.xyz — deploys from website-aura-landing branch via Amplify.',
        href: 'https://jid5274.gbautomation.xyz',
        badge: 'live',
        badgeTone: 'emerald' as const,
      },
      {
        slug: 'one-pager',
        title: 'Lumnen Clinical Partner one-pager',
        description: 'client-facing-one-pager.md — ready for outbound.',
      },
      {
        slug: 'apollo-spec',
        title: 'Apollo sequence spec',
        description: 'apollo-sequence-spec.md — not yet launched. Biggest unstarted needle-mover.',
        badge: 'unstarted',
        badgeTone: 'amber' as const,
      },
    ],
  },
  {
    heading: 'Sub-pages in vault',
    items: [
      {
        slug: 'apollo-sequence-spec',
        title: 'Apollo sequence spec',
        description:
          'apollo-sequence-spec.md — 5-step Lumnen Clinical Partner sequence, ready to launch',
        badge: 'unstarted',
        badgeTone: 'amber' as const,
      },
      {
        slug: 'client-facing-one-pager',
        title: 'Lumnen Clinical Partner one-pager',
        description:
          'client-facing-one-pager.md — outbound asset (also surfaced in Live assets above)',
        badge: 'asset ready',
        badgeTone: 'emerald' as const,
      },
      {
        slug: 'brand-canon',
        title: 'Brand canon',
        description: 'brand-canon.md — voice + positioning rules',
      },
      {
        slug: 'icp-decision',
        title: 'ICP vs BioReg decision memo',
        description: 'Why EWC targets cash-pay-curious vs BRT clinical-device pure-plays',
      },
      {
        slug: 'partner-pay',
        title: 'Partner pay flow',
        description: 'Revenue split + commission structure',
      },
      {
        slug: 'revenue-model',
        title: 'Revenue model',
        description: 'Pricing + margin per partner type',
      },
      {
        slug: 'sarasota-plan',
        title: 'Sarasota grassroots plan',
        description: 'Local-market activation playbook',
      },
    ],
  },
];

const KPIS = [
  { label: 'Composite rank', value: '#5 (19/30)' },
  { label: 'Outbound contacts', value: '0 (planned: 50)' },
  { label: 'Public landing', value: 'live' },
  { label: 'First mtg target', value: '3 (30d)' },
];

export function EWCPage(): React.ReactElement {
  return (
    <BusinessPage
      overviewRaw={overviewRaw}
      fallbackName="EWC — Elevated Wellness Collective"
      statusText="Active · Line #5"
      statusTone="emerald"
      kpis={KPIS}
      valueProps={VALUE_PROPS}
      sections={SECTIONS}
      prospects={PROSPECTS}
      prospectsHeading="EWC / Lumnen prospects"
      prospectsSubtitle={`${PROSPECTS.length} contacts — 50-contact list build is pending (Line 5 needle-mover)`}
      vaultPath={VAULT_PATH}
    />
  );
}
