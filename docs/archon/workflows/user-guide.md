# Cross-Functional Workflow User Guide

This guide explains how the product team uses the Archon workflow customization in day-to-day delivery.

## Who This Is For

Use these workflows when a product change needs repeatable cross-functional handling across product, design, engineering, QA, security, documentation, DevOps, and professional services.

The workflows are designed for a medium-sized single-product team where GitHub issues and pull requests are the system of record.

## What Archon Does For The Team

Archon turns team process into deterministic workflow files. Each workflow runs a defined set of steps, writes artifacts, and pauses for human approval at the right gates.

The AI helps research, draft, inspect, summarize, and validate. The workflow owns the order of operations and the handoff contracts.

## Core Ideas

- **Workflow**: A YAML file in `.archon/workflows/<function>/` that defines the process.
- **Command**: A reusable prompt template in `.archon/commands/<function>/`.
- **Artifact**: A generated file in `$ARTIFACTS_DIR` that passes context between functions.
- **Approval gate**: A human checkpoint where Archon pauses until the owner approves or provides corrections.
- **Worktree**: An isolated git workspace for change-producing workflows.

## Recommended Delivery Path

Most product work should move through this path:

1. Product creates or refines the request with `product-intake-to-prd`.
2. Design creates implementation-ready UX guidance with `design-brief-to-handoff`.
3. Development implements approved scope with `development-plan-to-pr`.
4. Security reviews risky changes with `security-risk-gate`.
5. QA validates the PR or release candidate with `qa-pr-validation`.
6. Documentation drafts user-facing updates with `docs-impact-and-release-notes`.
7. DevOps confirms deployment and rollback readiness with `devops-release-readiness`.
8. Professional Services prepares customer rollout with `services-customer-readiness`.

Not every change needs every workflow. Low-risk internal changes may skip design, docs, services, or DevOps if the PR template records `Not needed`. Security review is required when a security trigger is present.

## Starting A Workflow

Run a workflow from the repo root:

```bash
bun run cli workflow run product-intake-to-prd "Describe the product request here"
```

For follow-up workflows, reference the approved artifact, GitHub issue, PR, or release candidate:

```bash
bun run cli workflow run design-brief-to-handoff "Use the approved PRD for issue #123"
bun run cli workflow run security-risk-gate "Review PR #456 for auth and customer data impact"
bun run cli workflow run qa-pr-validation "Validate PR #456"
```

## Workflow Catalog

| Workflow | Use When | Main Owner | Primary Output |
|----------|----------|------------|----------------|
| `product-intake-to-prd` | A request needs product definition | Product Manager | `prd.md` |
| `design-brief-to-handoff` | Approved scope needs UX handoff | Designer | `design-brief.md`, `handoff.md` |
| `development-plan-to-pr` | Approved scope is ready to build | Developer | Pull request, `implementation-report.md` |
| `security-risk-gate` | Security trigger or risky change exists | Security | `security-signoff.md` |
| `qa-pr-validation` | A PR or release candidate needs QA | QA | `validation-report.md` |
| `docs-impact-and-release-notes` | User-facing behavior may need docs | Docs | `docs-impact.md`, `release-notes.md` |
| `devops-release-readiness` | A release needs deployment review | DevOps | `deployment-plan.md`, `rollback-plan.md` |
| `services-customer-readiness` | Customers or services delivery are affected | Professional Services | `customer-impact.md`, `implementation-readiness.md` |

## Artifact Expectations

Artifacts are the source of truth between workflow steps. Each artifact should be specific enough that another role can continue without reconstructing context.

Good artifacts include:

- Original request or source link
- Concrete decisions
- Open questions
- File paths or PR links when relevant
- Validation evidence
- Risks and required approvals
- Explicit scope and non-scope

Avoid vague artifacts like "looks good" or "fix the auth bug." Write the evidence, affected areas, and next action.

## Approval Gates

Approval gates are intentional. They keep the workflow deterministic without removing human judgment.

| Gate | Required Owner | Purpose |
|------|----------------|---------|
| Product approval | Product Manager | Confirms problem, goals, and scope |
| Design approval | Designer | Confirms UX handoff is ready |
| Build approval | Engineering lead or delegate | Confirms implementation scope |
| Security approval | Security owner | Clears or blocks security risk |
| QA approval | QA owner | Confirms validation result |
| Docs approval | Docs owner | Confirms customer-facing docs readiness |
| DevOps approval | DevOps owner | Confirms deployment and rollback readiness |
| Services approval | Services owner | Confirms customer enablement readiness |

If a gate is not needed, record `Not needed` in the PR template with a short reason.

## Security Gate Rules

Run `security-risk-gate` when a change touches:

- Authentication or authorization
- Permissions or privilege boundaries
- Secrets or tokens
- Payments
- PII or customer data
- Audit logs
- Infrastructure or IaC
- Dependency or supply-chain changes
- Public APIs
- Webhooks
- File upload or download
- Admin features
- External network exposure
- Labels such as `security-review`, `release-risk`, `customer-data`, or `auth`

Medium or high risk changes require security approval or documented risk acceptance before merge or release.

## GitHub Usage

Use GitHub issue templates to create structured intake:

- Feature request
- Bug report
- Customer request
- Incident follow-up
- Security-sensitive change

Use the PR template to link artifacts and record signoff:

- Product PRD / requirements
- Design handoff / UX review
- Implementation report
- Security review / signoff
- QA validation report
- Docs impact / release notes
- DevOps deployment / rollback plan
- Services customer readiness

## Pilot Checklist

For the first five real tickets:

- [ ] Start from a GitHub issue.
- [ ] Run `product-intake-to-prd`.
- [ ] Run only the downstream workflows that apply.
- [ ] Link artifacts in the PR.
- [ ] Record skipped gates as `Not needed` with a reason.
- [ ] Capture one improvement to the workflow or command templates after each ticket.

## Common Paths

### Low-Risk Copy Or Docs Change

1. `docs-impact-and-release-notes`
2. PR signoff by docs owner

### UI Feature

1. `product-intake-to-prd`
2. `design-brief-to-handoff`
3. `development-plan-to-pr`
4. `qa-pr-validation`
5. `docs-impact-and-release-notes`

### Auth Or Customer Data Change

1. `product-intake-to-prd`
2. `development-plan-to-pr`
3. `security-risk-gate`
4. `qa-pr-validation`
5. `devops-release-readiness`

### Customer-Facing Release

1. `qa-pr-validation`
2. `security-risk-gate`
3. `docs-impact-and-release-notes`
4. `devops-release-readiness`
5. `services-customer-readiness`

## Troubleshooting

If a workflow cannot find the right context, pass a more specific issue, PR, branch, or artifact path.

If an artifact is too vague, update the owning command template. The artifact is the handoff contract.

If a workflow feels too heavy, do not remove the approval gate silently. Change the workflow through PR review with the owning function.

If security review seems unnecessary, document why in the PR template. If any security trigger is present, run the security gate.

