# Assess a flaky or unsound test

Ground one test-stability complaint against this repository as it exists right now, prove what actually makes the test unreliable or worthless, and prescribe the real fix. You produce an assessment and a verdict; you change nothing. No one watches the run; the assessment file and your declared fields are the only things that persist.

You know nothing beyond this repository's checkout, its CI history, and the request below. You have no memory of previous runs and no awareness of flakes you may have assessed before. Everything you claim must be derived from files in this checkout, the project's own tooling, CI evidence you actually fetched, or the request itself — and your assessment must cite where each fact came from.

## The request

$INPUTS.target

If the block above is empty, the request is the message that started this run:

$ARGUMENTS

It may name a test, a file, a suite, or a CI run showing the failure. When it names no specific test, hunt: read recent CI history on the default branch (the forge CLI is available) and pick the strongest-evidenced flake — a test that fails intermittently across runs while the code it tests is untouched. A bare issue or run reference resolves against THIS repository unless the request says otherwise.

## How to assess

1. **Identify the victim precisely.** The exact test name, its file, the assertion that fails, and the platforms or jobs where it fails. Read the test and the code it exercises completely.
2. **Establish the healthy baseline before theorizing.** What does this test cost when it passes — duration, resources? Pull passing durations from green CI runs and, when practical, local runs; a failure log alone gives you the timeout and no baseline. The baseline tells you which of two profiles you have, and they take opposite fixes:
   - **Bimodal** — a tight cluster far below some bound, then isolated jumps to exactly that bound, nothing between. A hidden bound is being hit: a default per-test timeout, an internal timeout that happens to match it, undeclared I/O stalling until something gives up. Find the bound and the thing that meets it.
   - **Gradient** — a high, variable baseline creeping toward the budget. Genuine cost: count the work (process spawns, real database or network use, platform-expensive operations) rather than hunting a phantom race.
3. **Prove the mechanism.** Reproduce when practical: run the test repeatedly with the project's own runner, under the triggering condition (platform, parallelism, co-scheduled files) where you can. When it will not reproduce locally, build the causal case from evidence — durations, failure timestamps, what shares state with it — and say plainly that it is evidence, not reproduction. Name the exact coupling: undeclared I/O in a "mocked" test, shared mutable state across files, a sleep or timing race standing in for synchronization, subprocess or port contention, order dependence. "It is flaky" is a symptom, not a mechanism — the assessment is not done until the mechanism is named or the gap is.
4. **Judge what the test actually proves.** Name the faulty implementation this test would catch. If there is none — it asserts the mock, restates the code, or passes vacuously — that is itself the finding: the fix may be rewriting it to test the real behavior, or deleting it with that justification. A test that checks nothing defends nothing; keeping it green is not a goal.
5. **Prescribe the fix.** The bar: raising a timeout, adding a retry, widening a tolerance, or skipping on the affected platform is NOT a fix — it disarms the alarm and buries the defect the alarm exists to catch. The fix removes the coupling: declare or stub the I/O, isolate the shared state, replace the sleep with deterministic synchronization, make the expensive work cheap or in-process, split what never needed to be together. State the exact steps, and the proof bar the implementer must meet: how many consecutive runs under what condition demonstrate the flake dead, and — when the test's value is in doubt — how to show it still fails on the fault it exists to catch. When the mechanism's sufficiency cannot be proven from the checkout's evidence alone — races and timing above all — also name the escalation layer a proof of insufficiency would point to, with its blast radius, so the implementer is never stranded between a falsified prescription and an unauthorized improvisation. Prescribe quarantine (skip with a linked issue, stated loudly) only when the true fix is genuinely beyond one run's reach — an engine or product change — never as the convenient option.
6. **Decide.** `fix` when a real flake or unsound test exists and any executable path to the fix exists — choose the best path on the evidence and record the alternative you rejected and why: the operator judges your choice where it is concrete, in the pull request. `no_action` only when there is genuinely nothing to do: the test is already fixed on the current head, the complaint does not apply here, or a stop rule fires. State the reason plainly.

## Not your job

Do not edit any file or run anything that mutates the tree — this assessment is advisory and a guard verifies the tree is byte-identical after you finish. Do not perform the fix. Do not open issues or PRs. Do not assess other suspect tests you notice — note each in one line under "Also seen" and move on.

## Stop rules

If the request is ambiguous between several tests, present the candidates in the assessment and return `no_action` with the ambiguity as the reason — never pick one silently. If you cannot establish either a reproduction or a causal evidence chain — no CI history reachable, the failure never observed — say exactly what is missing and return `no_action`; a fix prescribed against an unproven mechanism is guessing with a work order attached.

## Assessment artifact

Write `$ARTIFACTS_DIR/stabilize-assessment.md`:

- **Target**: the test, file, failing assertion, and affected platforms or jobs.
- **Evidence**: healthy baseline, failure profile (bimodal or gradient, with the numbers), and the occurrences you verified — runs, durations, dates.
- **Mechanism**: the proven coupling, or the named evidence gap.
- **What the test proves**: the faulty implementation it catches — or the finding that it catches none.
- **Fix order**: the exact steps, the proof bar for "flake dead", and when applicable the proof that the test still catches its fault.
- **Also seen** (only if applicable): one line per unrelated suspect test.

Sections that do not apply are omitted, never filled with "N/A".

## Declare (every turn)

Before declaring, re-read your assessment against the checkout and the evidence: every test name, file path, duration, and run reference in it must be verifiable, and the fix order must be executable by someone who has read nothing but that file.

- `action` — `fix` or `no_action`
- `summary` — two or three sentences: what makes the test unreliable (or why nothing is owed) and why the action follows
