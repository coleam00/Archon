# Memory-recall probes (`.archon/evals/recall/`)

Measures the thing nothing else measures: **does a planted task actually trigger the
memory that should govern it?** `/evolve` writes rules and memories, but "memory alone
is weakest — it only fires if the description matches the next session's task." These
probes put a number on that firing rate.

Not run by the `standing-eval-suite` workflow — a different harness: each case spawns a
FRESH headless `claude -p` session in a throwaway fixture dir and greps the transcript
for binary evidence that the target memory's rule was APPLIED (not merely mentioned).

## Run it

```bash
bun .archon/scripts/recall-probe.ts                 # all cases, 3 runs each
bun .archon/scripts/recall-probe.ts verify-artifact-recall   # one case
RECALL_RUNS=1 bun .archon/scripts/recall-probe.ts   # quick smoke (n=1 — NOT calibration)
```

Report: per-case fired/total + overall firing rate, appended to
`.archon/state/recall-history.jsonl`. n=3 minimum for any trust claim.

## Case schema (`cases/*.json` — JSON so the runner stays dep-free; no AI judge reads these)

```json
{
  "id": "kebab-unique-id",
  "memory": "feedback_target_memory.md",
  "task": "the planted prompt for the fresh session",
  "fixture": [{ "path": "data/a.txt", "content": "files created in the throwaway dir\n" }],
  "evidence": ["(?i)ALL of these must match the transcript => fired"],
  "forbidden": ["(?i)ANY match => NOT fired (rule violated)"]
}
```

A fixture named `init.sh` is executed (bash) in the throwaway dir before the probe —
use it for `git init` style setup.

Binary per run (Shankar: binary metrics are alignable); fired iff every `evidence`
matches and no `forbidden` matches.

## Rules

- A low firing rate is a FINDING about the memory's description/index hook — fix the
  memory (strengthen its hook line), don't soften the evidence regexes.
- Keep tasks side-effect-free: throwaway fixture dirs only, no network writes, no repo
  mutations outside the fixture.
- Probe sessions run on the `sonnet` tier (daily-driver realism without flagship cost).
