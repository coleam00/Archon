/**
 * Pure helpers for translating between an `AgentDetail` (server shape) and a
 * structured editor draft. The draft surface is what tabs read/write; the
 * frontmatter is what we ship over the wire on save.
 *
 * Unknown frontmatter keys round-trip through `extras` so editing through
 * the UI doesn't strip fields the user added by hand.
 */

import type { AgentDetail, AgentStatus } from '@/lib/api';

export type ResponseLength = 'concise' | 'balanced' | 'detailed';
export type Tone = 'friendly' | 'business' | 'direct' | 'playful';
export type EmojiUse = 'none' | 'sparingly' | 'often';

export interface Identity {
  responseLength: ResponseLength;
  tone: Tone;
  emoji: EmojiUse;
  showSource: boolean;
  feedbackButtons: boolean;
}

export interface AgentDraft {
  name: string;
  description: string;
  status: AgentStatus;
  model: string;
  body: string;
  tools: string[];
  disallowedTools: string[];
  mcp: string;
  skills: string[];
  maxTurns: number | null;
  identity: Identity;
  /** Other frontmatter fields the structured form doesn't surface. */
  extras: Record<string, unknown>;
}

const KNOWN_KEYS = new Set([
  'name',
  'description',
  'status',
  'model',
  'tools',
  'disallowedTools',
  'mcp',
  'skills',
  'max_turns',
  'identity',
]);

const DEFAULT_IDENTITY: Identity = {
  responseLength: 'balanced',
  tone: 'friendly',
  emoji: 'none',
  showSource: false,
  feedbackButtons: false,
};

function asArrayOfStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string');
}

function coerceResponseLength(raw: unknown): ResponseLength {
  return raw === 'concise' || raw === 'detailed' ? raw : 'balanced';
}
function coerceTone(raw: unknown): Tone {
  return raw === 'business' || raw === 'direct' || raw === 'playful' ? raw : 'friendly';
}
function coerceEmoji(raw: unknown): EmojiUse {
  return raw === 'sparingly' || raw === 'often' ? raw : 'none';
}
function coerceStatus(raw: unknown): AgentStatus {
  return raw === 'draft' || raw === 'archived' ? raw : 'active';
}

function readIdentity(raw: unknown): Identity {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_IDENTITY };
  const id = raw as Record<string, unknown>;
  return {
    responseLength: coerceResponseLength(id.responseLength),
    tone: coerceTone(id.tone),
    emoji: coerceEmoji(id.emoji),
    showSource: id.showSource === true,
    feedbackButtons: id.feedbackButtons === true,
  };
}

export function detailToDraft(detail: AgentDetail): AgentDraft {
  const fm = detail.frontmatter;
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (!KNOWN_KEYS.has(k)) extras[k] = v;
  }
  return {
    name: typeof fm.name === 'string' ? fm.name : detail.name,
    description: typeof fm.description === 'string' ? fm.description : '',
    status: coerceStatus(fm.status),
    model: typeof fm.model === 'string' ? fm.model : '',
    body: detail.body,
    tools: asArrayOfStrings(fm.tools),
    disallowedTools: asArrayOfStrings(fm.disallowedTools),
    mcp: typeof fm.mcp === 'string' ? fm.mcp : '',
    skills: asArrayOfStrings(fm.skills),
    maxTurns: typeof fm.max_turns === 'number' ? fm.max_turns : null,
    identity: readIdentity(fm.identity),
    extras,
  };
}

export function draftToFrontmatter(draft: AgentDraft): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    name: draft.name,
    description: draft.description,
  };
  fm.status = draft.status;
  if (draft.model.trim()) fm.model = draft.model.trim();
  if (draft.tools.length > 0) fm.tools = draft.tools;
  if (draft.disallowedTools.length > 0) fm.disallowedTools = draft.disallowedTools;
  if (draft.mcp.trim()) fm.mcp = draft.mcp.trim();
  if (draft.skills.length > 0) fm.skills = draft.skills;
  if (typeof draft.maxTurns === 'number' && draft.maxTurns > 0) {
    fm.max_turns = draft.maxTurns;
  }
  // Always emit identity so the chat preview reads a known shape — even when
  // every field is at its default.
  fm.identity = {
    responseLength: draft.identity.responseLength,
    tone: draft.identity.tone,
    emoji: draft.identity.emoji,
    showSource: draft.identity.showSource,
    feedbackButtons: draft.identity.feedbackButtons,
  };
  return { ...fm, ...draft.extras };
}

export function draftIsDirty(a: AgentDraft, b: AgentDraft): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

export const RESPONSE_LENGTH_OPTIONS: { value: ResponseLength; label: string }[] = [
  { value: 'concise', label: 'Concise' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'detailed', label: 'Detailed' },
];

export const TONE_OPTIONS: { value: Tone; label: string }[] = [
  { value: 'friendly', label: 'Friendly' },
  { value: 'business', label: 'Business' },
  { value: 'direct', label: 'Direct' },
  { value: 'playful', label: 'Playful' },
];

export const EMOJI_OPTIONS: { value: EmojiUse; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'sparingly', label: 'Sparingly' },
  { value: 'often', label: 'Often' },
];

export const STATUS_OPTIONS: { value: AgentStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'draft', label: 'Draft' },
  { value: 'archived', label: 'Archived' },
];
