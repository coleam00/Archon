# Examples

## Minimal Classify and Report

```yaml
name: classify-request
description: |
  Use when: User wants to classify a request.
  Triggers: "classify request", "what kind of request is this".
  Does: Classifies the input and prints a deterministic report.
  NOT for: Implementing code.

provider: claude
model: small

nodes:
  - id: classify
    prompt: |
      Classify the user request.
      Request: $ARGUMENTS
      Return JSON only.
    allowed_tools: []
    output_format:
      type: object
      properties:
        kind:
          type: string
          enum: [bug, feature, question]
        confidence:
          type: number
      required: [kind, confidence]

  - id: report
    depends_on: [classify]
    bash: |
      set -euo pipefail
      kind=$classify.output.kind
      confidence=$classify.output.confidence
      printf 'kind=%s confidence=%s\n' "$kind" "$confidence"
```

## Command Node with Fresh Context

```yaml
nodes:
  - id: plan
    command: archon-create-plan
    model: medium
    context: fresh

  - id: implement
    command: archon-implement-tasks
    depends_on: [plan]
    model: large
    context: fresh
    idle_timeout: 1800000
```

## Human Approval Gate

```yaml
name: plan-then-apply
description: |
  Use when: User wants a plan reviewed before implementation.
  Triggers: "plan then apply", "approve before coding".
  Does: Creates a plan, waits for approval, then implements.
  NOT for: Fully autonomous quick fixes.

provider: claude
interactive: true

nodes:
  - id: plan
    prompt: |
      Create an implementation plan for:
      $ARGUMENTS
    model: medium

  - id: approve-plan
    depends_on: [plan]
    approval:
      message: |
        Review this plan:
        $plan.output
      capture_response: true
      on_reject:
        prompt: |
          The user rejected the plan for this reason:
          $REJECTION_REASON
          Revise the plan and summarize what changed.
        max_attempts: 3

  - id: implement
    depends_on: [approve-plan]
    prompt: |
      Implement the approved plan.
      Plan:
      $plan.output
      Approval notes:
      $approve-plan.output
    model: large
    context: fresh
```

## Route-loop Review and Fix

```yaml
name: review-fix-route-loop
description: |
  Use when: User wants an implementation reviewed and fixed until it passes.
  Triggers: "review fix loop", "fix until review passes".
  Does: Implements, reviews JSON verdict, reruns fix path on negative verdict, exits on pass or escalation.
  NOT for: Human-guided planning.

provider: claude
model: medium

nodes:
  - id: fix
    prompt: |
      Implement or fix the requested work:
      $ARGUMENTS
    model: large
    context: fresh

  - id: review
    depends_on: [fix]
    prompt: |
      Review the latest changes.
      Return JSON only with result positive or negative and a summary.
    allowed_tools: [Bash, Read]
    output_format:
      type: object
      properties:
        result:
          type: string
          enum: [positive, negative]
        summary:
          type: string
      required: [result, summary]

  - id: review-router
    depends_on: [review]
    route_loop:
      from: review
      condition: "$review.output.result == 'positive'"
      max_iterations: 3
      routes:
        positive: done
        negative: fix
        exhausted: escalation

  - id: done
    depends_on: [review-router]
    bash: |
      printf 'Review passed: %s\n' $review.output.summary

  - id: escalation
    depends_on: [review-router]
    prompt: |
      The review did not pass within the iteration limit.
      Latest review:
      $review.output
      Summarize remaining work for the user.
    allowed_tools: []
```

## Deterministic Script Transform

```yaml
nodes:
  - id: collect
    bash: |
      set -euo pipefail
      gh issue list --limit 20 --json number,title,labels

  - id: summarize-json
    depends_on: [collect]
    script: |
      const issues = $collect.output;
      const result = issues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        labelCount: issue.labels.length,
      }));
      console.log(JSON.stringify({ count: result.length, issues: result }));
    runtime: bun
    timeout: 30000
```

## Cleanup with `all_done`

```yaml
nodes:
  - id: start-server
    bash: |
      set -euo pipefail
      bun run dev > "$ARTIFACTS_DIR/server.log" 2>&1 &
      echo "$!" > "$ARTIFACTS_DIR/server.pid"

  - id: test-ui
    depends_on: [start-server]
    prompt: |
      Run browser validation for $ARGUMENTS.
    idle_timeout: 900000

  - id: cleanup
    depends_on: [test-ui]
    trigger_rule: all_done
    bash: |
      pid="$(cat "$ARTIFACTS_DIR/server.pid" 2>/dev/null || true)"
      if [ -n "$pid" ]; then
        kill "$pid" 2>/dev/null || true
      fi
      echo "cleanup complete"
```

## Read-only Live Checkout Workflow

```yaml
name: repo-report
description: |
  Use when: User wants a read-only repository report.
  Triggers: "repo report", "summarize repo".
  Does: Reads repository metadata and writes a report artifact.
  NOT for: Code changes.

worktree:
  enabled: false
mutates_checkout: false
provider: claude
model: small

nodes:
  - id: inspect
    bash: |
      set -euo pipefail
      printf 'branch=%s\n' "$(git branch --show-current)"
      printf 'head=%s\n' "$(git rev-parse --short HEAD)"

  - id: summarize
    depends_on: [inspect]
    prompt: |
      Summarize this repository state:
      $inspect.output
    allowed_tools: []
```
