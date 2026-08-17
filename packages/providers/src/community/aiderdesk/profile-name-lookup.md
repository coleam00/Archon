# AiderDesk profile-name lookup — contract reference

**Applies to**: `provider: aiderdesk`. The `model:` slot on a workflow node and on
a `.archon/config.yaml` tier preset is a **human-readable AiderDesk
agent-profile name**.

## Source of truth

AiderDesk's REST live catalog: `GET /api/agent-profiles` (plural; `/api/agents`
also exists but is the same data wrapped differently — we use the plural form
because the AiderDesk provider has used it since the initial dual-bind at
`9847d8d`). Per profile record exposes at least:

| field | meaning |
|---|---|
| `id` | UUID-stable identifier — the value archon POSTs as `agentProfileId` |
| `name` | human-readable label — what archon looks up by |
| `provider` | the inference provider this profile uses by default (e.g. `poe`, `ollama`) |
| `model` | the inference model this profile uses by default (e.g. `minimax-m3`, `internlm/internlm2.5:7b-8k`) |
| `ruleFiles` | count of rule files attached to this profile (0 or >0) |

Live catalog TTL: **60 s**, per-provider-instance.

## Resolution algorithm (resolution path — non-heuristic)

1. If `assistantConfig.agentProfileId` is set → use it as the profile UUID
   verbatim. Skip the catalog lookup. (Operator pin.)
2. Otherwise, fetch the catalog (cached). Look up `name === requestOptions.model`
   with **case-sensitive, exact, full-string match**. Empty string misses.
3. On hit: bind `updateTask.agentProfileId = matched.id`. Done.
4. On miss: throw `UnknownAiderDeskAgentProfileError(requestedName, knownNames, candidates)`.
   No fallback. No project-default substitute. No chunk. No retry.

The lookup is **not** case-insensitive, **not** substring, **not** Levenshtein,
**not** prefix-match. Anything that would let a misspelling substitute a profile
is explicitly rejected. The helper `nearestNames(target, candidates)` runs
purely to populate the typed-error's `.candidates` hint — never as a resolution
input.

## `modelOverride` (optional, sibling of `model:`)

When `requestOptions.modelOverride !== undefined`, archon validates the literal
string against the joined `<providerId>/<id>` set of `GET /api/models` (cached).
On miss → throw `InvalidAiderDeskModelOverrideError(model, knownModels)`.
**Hard error, no retry, no fallback, no chunk.**

When `modelOverride === undefined`: archon does **NOT** fetch what the profile's
default `model` would resolve to; archon **omits `mainModel`** from the
`updateTask` body. AiderDesk uses the profile's own default. This means the
profile's default can drift on AiderDesk's side without archon noticing — that
is intentional. AiderDesk owns profile defaults; archon is not the source of
truth.

## Did-you-mean hint (error message only)

`UnknownAiderDeskAgentProfileError.candidates` is the top-5 nearest profile
names by Levenshtein distance OR by short substring containment. Rules:

- Substring containment of a profile which is short enough to be plausibly a
  typo (e.g. target = `PowerToo` — substring containment of `Power Tools`) is
  ranked **like** Levenshtein-1, not Levenshtein-0. Tiebreaker: lex order.
- Levenshtein distance ≤ 2 from a profile exact name? Hint it.
- Levenshtein distance > 5? Drop it.

This is purely diagnostic. The user sees something like:

```
Unknown AiderDesk agent profile: 'PowerToo'. Known names: [
  Poe, Aider, Inspector, Codenomicron, Power Tools, Aider with Power Search
]. Did you mean: Power Tools?
```

…and corrects their YAML. No auto-substitution. No retry against the candidate.

## Worked example

`.archon/config.yaml`:

```yaml
tiers:
  small:
    provider: aiderdesk
    model: Power Tools        # resolved to agent-profile UUID
  medium:
    provider: aiderdesk
    model: Aider
  large:
    provider: aiderdesk
    model: Poe
```

Workflow YAML referencing tier:

```yaml
- id: review-changes
  provider: aiderdesk
  model: large               # → tier keyword 'large' → profile 'Poe'
  modelOverride: ollama/internlm/internlm2.5:7b-8k  # optional pin
  prompt: |
    Review the diff in $CWD. Return a structured summary.
```

On this node archon POSTs `updateTask({ agentProfileId: <Poe UUID>, mainModel: 'ollama/internlm/internlm2.5:7b-8k', currentMode: 'agent', workingMode: 'local' })`.

If `modelOverride: 'ollama/totally-fake-model'` → throws `InvalidAiderDeskModelOverrideError` before any AiderDesk call.

If the workflow instead said `model: Po` (typo, missing `e`) → throws `UnknownAiderDeskAgentProfileError('Po', knownNames, candidates=['Poe'])`.

## Code map

| Symbol | Location |
|---|---|
| `UnknownAiderDeskAgentProfileError` | `packages/providers/src/community/aiderdesk/errors.ts` |
| `InvalidAiderDeskModelOverrideError` | `packages/providers/src/community/aiderdesk/errors.ts` |
| `levenshtein(a, b)` | `packages/providers/src/community/aiderdesk/profile-matcher.ts` |
| `nearestNames(target, candidates, k)` | `packages/providers/src/community/aiderdesk/profile-matcher.ts` |
| `AiderDeskProvider.sendQuery` resolution | `packages/providers/src/community/aiderdesk/provider.ts` (region: RESOLVE profile) |
| Catalog pre-warm for boot validation | `packages/core/src/orchestrator/aiderdesk-catalog.ts` |
| `SendQueryOptions.modelOverride` field | `packages/providers/src/types.ts` |
