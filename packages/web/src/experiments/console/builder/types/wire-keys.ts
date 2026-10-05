/**
 * How the builder carries each key of the generated wire node through an
 * open-and-save. This record is the owner of that decision: the base-key type,
 * the partitioner's runtime key set and the variants' `wireKeys` all derive
 * from it.
 *
 *   - `id`      — partitioned out as `BuilderNode.id`
 *   - `base`    — shared by every node; carried verbatim in `BuilderNode.base`
 *   - `variant` — belongs to an editable variant; carried by the converters of
 *                 the variants that list it in `wireKeys`
 *   - `opaque`  — only on node modes the builder has no editor for; carried
 *                 verbatim in an opaque node's `fields`
 *
 * `satisfies Record<keyof WireDagNode, …>` makes a field the engine adds a
 * compile error here until it is given a role, instead of a field the builder
 * drops on save.
 */
import type { WireDagNode } from './wire';

type WireKeyRole = 'id' | 'base' | 'variant' | 'opaque';

export const WIRE_KEY_ROLES = {
  id: 'id',

  description: 'base',
  depends_on: 'base',
  when: 'base',
  trigger_rule: 'base',
  model: 'base',
  provider: 'base',
  context: 'base',
  output_format: 'base',
  allowed_tools: 'base',
  denied_tools: 'base',
  idle_timeout: 'base',
  retry: 'base',
  hooks: 'base',
  mcp: 'base',
  skills: 'base',
  plugins: 'base',
  agents: 'base',
  effort: 'base',
  maxBudgetUsd: 'base',
  systemPrompt: 'base',
  fallbackModel: 'base',
  settingSources: 'base',
  pi: 'base',
  mutates_checkout: 'base',
  betas: 'base',
  sandbox: 'base',
  always_run: 'base',
  persist_session: 'base',
  output_type: 'base',

  // `timeout` and `on_timeout` sit top-level on the flattened wire type, but the
  // engine accepts `timeout` only on bash, script and loop nodes and `on_timeout`
  // only on bash and script nodes, so they are variant keys.
  command: 'variant',
  prompt: 'variant',
  bash: 'variant',
  script: 'variant',
  runtime: 'variant',
  deps: 'variant',
  timeout: 'variant',
  on_timeout: 'variant',
  with: 'variant',
  loop: 'variant',
  approval: 'variant',
  wait: 'variant',
  cancel: 'variant',

  loop_group: 'opaque',
  workflow: 'opaque',
  include: 'opaque',
  input: 'opaque',
  isolation: 'opaque',
  fan_out: 'opaque',
} as const satisfies Record<keyof WireDagNode, WireKeyRole>;

type WireKeyWithRole<R extends WireKeyRole> = {
  [K in keyof typeof WIRE_KEY_ROLES]: (typeof WIRE_KEY_ROLES)[K] extends R ? K : never;
}[keyof typeof WIRE_KEY_ROLES];

/** The wire keys shared by every node, excluding `id`. */
export type WireBaseKey = WireKeyWithRole<'base'>;

/** The wire keys that belong to editable variants. */
export type WireVariantKey = WireKeyWithRole<'variant'>;

/** The wire keys carrying a given role, as a runtime list. */
export function wireKeysWithRole(role: WireKeyRole): string[] {
  return Object.entries(WIRE_KEY_ROLES)
    .filter(([, keyRole]) => keyRole === role)
    .map(([key]) => key);
}
