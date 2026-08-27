---
name: archon-cli-prompting-mistakes
description: Common prompt mistakes when invoking Archon workflows or writing node prompts. Short, negative-form guidance. Read before dispatching work or authoring prompts.
---

# Prompting Basics

## General

1. Agents are smart — take advantage of that. Each command node runs a real
   coding-agent harness under the hood, with all its capabilities.
2. Agents inside Archon do not necessarily know about Archon itself, this run,
   or past failures. Do not reference context the agent has no awareness of.

# Prompting Mistakes

Short list. Applies in two places: the **message you pass when invoking a
workflow** (it becomes `$ARGUMENTS` for the whole run) and the **prompts inside
command/prompt nodes** you author.

## The mistakes

1. **Vague outcome, implied method.** "Look into the auth thing." Say what done
   looks like and where context lives: "Fix issue #42. Use the issue, comments,
   and current source as evidence. Preserve the documented login behavior."
2. **Smuggling your diagnosis.** If you want the run's investigation tested,
   ask for the fix in ordinary language — do not hand it your suspected root
   cause as fact unless you have proven it.
3. **Narrating to nobody.** Unattended nodes produce artifacts, commits, and
   declared fields — not chat. Prompts that say "report to me below" produce
   output nothing ever reads. Point every instruction at the artifact it serves.
4. **No evidence bar.** A judging prompt without "cite the causal line / drop
   anything that rests on 'might'" collects plausible filler. State what counts
   as proof, and demand silence otherwise.
5. **Trusting exit codes as verdicts.** A declined task exits 0. Gates read
   artifacts and declared fields, not success bits.
6. **Prose wire formats.** Asking a node to end with a magic token the next node
   greps. Use structured output fields or script exit codes instead.
7. **Everything-but-the-kitchen-sink scope.** One node, one job, stated non-goals.
   "Also update docs and tests and the changelog" dilutes all three. Negative
   scope ("do not touch the lockfile") is as load-bearing as positive.
8. **Assuming memory.** Each node may be a fresh session with no prior context.
   Restate the input path, artifact path, and constraint inside each prompt.
9. **Stop rules left unstated.** Tell the agent when to stop and surface:
   ambiguity → present options; missing context → name it. Never "use judgment"
   on decisions with real cost.
10. **Soft failure language.** "Try to..." invites theater. Put checkable failure
    in a `bash:`/`script:` node whose exit code fails the run, or have a judging
    node return a structured boolean and gate on it deterministically.

## The one-line test

Before sending any prompt — invocation or node — ask: *could a competent engineer
who has never seen this conversation act on exactly this text?* If the answer
needs context that lives only in your head, the prompt is not done.
