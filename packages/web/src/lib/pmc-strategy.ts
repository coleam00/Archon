import serviceMixRaw from '@second-brain/businesses/pmc/strategy/service-mix.md?raw';
import revenueLinesRaw from '@second-brain/businesses/pmc/strategy/revenue-lines.md?raw';
import valuePropsRaw from '@second-brain/businesses/pmc/strategy/value-props.md?raw';

/**
 * Extract the first ```json ... ``` fenced block from a markdown source and
 * parse it. Returns null if no block is present or JSON.parse fails — callers
 * are responsible for falling back to a safe default in that case so the
 * dashboard never renders with an empty surface.
 */
function extractJsonBlock(raw: string): unknown {
  const match = /```json\s*\n([\s\S]*?)\n```/.exec(raw);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as unknown;
  } catch {
    return null;
  }
}

/**
 * Extract a `last_reviewed: <date>` field from YAML frontmatter for the
 * "last reviewed" stamp displayed next to vault-sourced cards.
 */
function extractLastReviewed(raw: string): string | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!fm) return null;
  const line = fm[1].split(/\r?\n/).find(l => l.trim().startsWith('last_reviewed:'));
  if (!line) return null;
  return line.slice(line.indexOf(':') + 1).trim();
}

// --- Service mix (PMC pillar weights) ---

export interface PmcPillar {
  name: string;
  value: number;
  color: string;
}

const DEFAULT_PILLARS: PmcPillar[] = [
  { name: 'Fractional C-Suite', value: 35, color: '#1e40af' },
  { name: 'Systems & Automation', value: 25, color: '#c9a84c' },
  { name: 'RCM Optimization', value: 30, color: '#10b981' },
  { name: 'Talent Acquisition', value: 10, color: '#f59e0b' },
];

function parsePillars(raw: string): PmcPillar[] {
  const parsed = extractJsonBlock(raw) as { pillars?: PmcPillar[] } | null;
  if (
    !parsed ||
    !Array.isArray(parsed.pillars) ||
    parsed.pillars.length === 0 ||
    !parsed.pillars.every(
      p => typeof p.name === 'string' && typeof p.value === 'number' && typeof p.color === 'string'
    )
  ) {
    return DEFAULT_PILLARS;
  }
  return parsed.pillars;
}

export const PMC_PILLARS: PmcPillar[] = parsePillars(serviceMixRaw);
export const PMC_PILLARS_LAST_REVIEWED: string | null = extractLastReviewed(serviceMixRaw);

// --- Revenue lines (composite scoring) ---

export interface PmcRevenueLine {
  name: string;
  composite: number;
  marketability: number;
  readiness: number;
  cycleSpeed: number;
}

const DEFAULT_REVENUE_LINES: PmcRevenueLine[] = [
  { name: 'PMC (RCM Audit)', composite: 22, marketability: 7, readiness: 7, cycleSpeed: 8 },
  { name: 'BRT (BH-Therapy)', composite: 25, marketability: 9, readiness: 9, cycleSpeed: 7 },
  { name: 'BRT (Chiro+Medspa)', composite: 22, marketability: 8, readiness: 8, cycleSpeed: 6 },
  {
    name: "EWC + Lumnen (Jason's LLC)",
    composite: 19,
    marketability: 6,
    readiness: 8,
    cycleSpeed: 5,
  },
  { name: 'Fountain WPB', composite: 24, marketability: 8, readiness: 7, cycleSpeed: 8 },
  { name: 'AccuFit', composite: 20, marketability: 6, readiness: 7, cycleSpeed: 7 },
];

function parseRevenueLines(raw: string): PmcRevenueLine[] {
  const parsed = extractJsonBlock(raw) as { revenueLines?: PmcRevenueLine[] } | null;
  if (
    !parsed ||
    !Array.isArray(parsed.revenueLines) ||
    parsed.revenueLines.length === 0 ||
    !parsed.revenueLines.every(
      r =>
        typeof r.name === 'string' &&
        typeof r.composite === 'number' &&
        typeof r.marketability === 'number' &&
        typeof r.readiness === 'number' &&
        typeof r.cycleSpeed === 'number'
    )
  ) {
    return DEFAULT_REVENUE_LINES;
  }
  return parsed.revenueLines;
}

export const PMC_REVENUE_LINES: PmcRevenueLine[] = parseRevenueLines(revenueLinesRaw);
export const PMC_REVENUE_LINES_LAST_REVIEWED: string | null = extractLastReviewed(revenueLinesRaw);

// --- Value props ---

export type PmcValuePropIconName =
  | 'DollarSign'
  | 'Target'
  | 'TrendingUp'
  | 'Users'
  | 'ArrowUpRight';

export interface PmcValueProp {
  title: string;
  body: string;
  icon: PmcValuePropIconName;
}

const ALLOWED_ICONS: ReadonlySet<PmcValuePropIconName> = new Set([
  'DollarSign',
  'Target',
  'TrendingUp',
  'Users',
  'ArrowUpRight',
]);

const DEFAULT_VALUE_PROPS: PmcValueProp[] = [
  {
    title: 'Grand Slam RCM Audit',
    body: 'Recover 8-15% of leaked revenue from coding, denials, and AR-aging gaps. Audit ticket $7.5K-$15K, >70% margin, 30-60 day close cycle.',
    icon: 'DollarSign',
  },
  {
    title: 'Cash-pay practice transformation',
    body: 'Fractional VP-Sales / BD leadership for clinics pivoting from insurance to concierge, DPC, and cash-pay. Proven playbook + outbound systems.',
    icon: 'Target',
  },
  {
    title: 'Portfolio cross-sell',
    body: 'A single PMC engagement opens BRT, EWC, Fountain, and AccuFit upsell paths. One advisory contract → multi-line recurring revenue.',
    icon: 'TrendingUp',
  },
];

function parseValueProps(raw: string): PmcValueProp[] {
  const parsed = extractJsonBlock(raw) as { valueProps?: PmcValueProp[] } | null;
  if (
    !parsed ||
    !Array.isArray(parsed.valueProps) ||
    parsed.valueProps.length === 0 ||
    !parsed.valueProps.every(
      v =>
        typeof v.title === 'string' &&
        typeof v.body === 'string' &&
        typeof v.icon === 'string' &&
        ALLOWED_ICONS.has(v.icon)
    )
  ) {
    return DEFAULT_VALUE_PROPS;
  }
  return parsed.valueProps;
}

export const PMC_VALUE_PROPS: PmcValueProp[] = parseValueProps(valuePropsRaw);
export const PMC_VALUE_PROPS_LAST_REVIEWED: string | null = extractLastReviewed(valuePropsRaw);
