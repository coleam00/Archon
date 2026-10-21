// Generated from .archon/workflows/sdlc/merge-queue/archon-merge-queue.yaml, node sweep.
// Regenerate: bun run generate:merge-sweep-contract
// Schema SHA-256: 5ec5b885ca1e9585d5c02a906f7401bfe3f7d77cc1d2ab8d2c386b3c78f28492
import { nullableJson } from './io.ts';

export type Sweep = {
  readonly "decisions": ReadonlyArray<{
    readonly "number": number;
    readonly "action": "merged" | "return" | "ask" | "wait";
    readonly "class": "clear" | "unclear";
    readonly "head": string;
    readonly "reran": boolean;
    readonly "reason": string;
    readonly "brief": string;
    readonly "attention": {
      readonly "what": string;
      readonly "why": string;
      readonly "recommendation": {
        readonly "choice": string;
        readonly "why": string;
        readonly "evidence": string;
        readonly "confidence": "low" | "medium" | "high";
        readonly "would_change": string;
      };
      readonly "choices": ReadonlyArray<{
        readonly "id": string;
        readonly "label": string;
        readonly "does": string;
        readonly "effect": "merge" | "return" | "park";
        readonly "ruling": string;
      }>;
      readonly "if_unanswered": string;
      readonly "links": ReadonlyArray<string>;
    } | null;
  }>;
  readonly "base": {
    readonly "summary": string;
    readonly "reran": boolean;
    readonly "attention": {
      readonly "what": string;
      readonly "why": string;
      readonly "recommendation": {
        readonly "choice": string;
        readonly "why": string;
        readonly "evidence": string;
        readonly "confidence": "low" | "medium" | "high";
        readonly "would_change": string;
      };
      readonly "choices": ReadonlyArray<{
        readonly "id": string;
        readonly "label": string;
        readonly "does": string;
        readonly "effect": "hold";
        readonly "ruling": string;
      }>;
      readonly "if_unanswered": string;
      readonly "links": ReadonlyArray<string>;
    } | null;
  };
  readonly "summary": string;
};
export type SweepDecision = Sweep['decisions'][number];
export type MergeAttention = NonNullable<SweepDecision['attention']>;
export type BaseAttention = NonNullable<Sweep['base']['attention']>;
export type SweepAction = SweepDecision['action'];
export type PolicyClass = SweepDecision['class'];
export type MergeEffect = MergeAttention['choices'][number]['effect'];
export const SWEEP_ACTIONS = ["merged","return","ask","wait"] as const;
export const POLICY_CLASSES = ["clear","unclear"] as const;
export const MERGE_EFFECTS = ["merge","return","park"] as const;
export const BASE_EFFECTS = ["hold"] as const;

/** Reads the engine-certified whole sweep output, or null when the sweep was skipped. */
export function readSweep(value: string | undefined): Sweep | null {
  return nullableJson(value) as Sweep | null;
}
