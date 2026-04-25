# Cross-Functional Archon Workflow Rollout

This directory captures the product-team Archon customization. The goal is to make cross-functional delivery repeatable across product, design, development, QA, security, documentation, DevOps, and professional services.

## Operating Model

- GitHub issues and pull requests are the system of record.
- Repo docs and Archon artifacts are the long-lived decision trail.
- Each function owns its commands and artifact templates under `.archon/commands/<function>/`.
- Each function owns its workflows under `.archon/workflows/<function>/`.
- Any change-producing workflow should run in an isolated worktree.
- Read-only planning, review, and approval workflows set `worktree.enabled: false`.
- Human approval gates remain mandatory for product scope, design handoff, security signoff, QA signoff, deployment readiness, and customer-facing launch readiness.

## Branch Strategy

This customization is maintained on the `product-team-workflows` branch of the fork. Keep it separate from upstream Archon until the team decides whether these templates should remain private/product-specific or be generalized for contribution.

Recommended promotion path:

1. Iterate on `product-team-workflows`.
2. Run pilot workflows on real tickets.
3. Split product-specific wording from reusable templates.
4. Keep private process templates in a separate repo if they reference internal customers, systems, security practices, or roadmap data.
5. Upstream only generic workflow patterns that are useful to Archon users broadly.

## Pilot Workflows

| Function | Workflow | Purpose | Primary Artifacts |
|----------|----------|---------|-------------------|
| Product | `product-intake-to-prd` | Turn intake into approved PRD | `requirements.md`, `prd.md`, `decision-log.md` |
| Design | `design-brief-to-handoff` | Turn PRD into UX handoff | `design-brief.md`, `handoff.md`, `ux-review.md` |
| Development | `development-plan-to-pr` | Implement approved work and open PR | `implementation-plan.md`, `implementation-report.md` |
| Security | `security-risk-gate` | Classify and clear/block risky changes | `security-review.md`, `threat-model.md`, `risk-acceptance.md`, `security-signoff.md` |
| QA | `qa-pr-validation` | Produce QA test plan and validation verdict | `test-plan.md`, `regression-selection.md`, `validation-report.md` |
| Docs | `docs-impact-and-release-notes` | Review docs impact and draft release notes | `docs-impact.md`, `user-guide-delta.md`, `release-notes.md` |
| DevOps | `devops-release-readiness` | Review deployment and rollback readiness | `deployment-plan.md`, `rollback-plan.md`, `infra-risk-review.md` |
| Services | `services-customer-readiness` | Prepare customer enablement and rollout | `customer-impact.md`, `implementation-readiness.md`, `feedback-to-product.md` |

## Function Catalog

### Product Management

- `product/intake-triage`: classify request as bug, feature, experiment, customer ask, tech debt, support escalation, or incident follow-up.
- `product/prd-guided`: create PRD through structured questions and approval gates.
- `product/scope-change-review`: compare requested scope change against approved PRD and recommend accept, defer, or reject.

### Design

- `design/design-brief`: convert PRD into UX goals, user flows, states, constraints, and open questions.
- `design/ui-review`: review PR or screenshots for consistency, accessibility, layout, and interaction quality.
- `design/handoff-check`: verify implementation has design assets, states, edge cases, and acceptance notes.

### Development

- `development/plan-to-pr`: implement approved plan in a worktree, validate, create PR.
- `development/bugfix-to-pr`: investigate bug, reproduce, fix, validate, create PR.
- `development/refactor-safely`: plan refactor, constrain blast radius, validate behavior, summarize risk.

### Security

- `security/security-risk-gate`: classify whether security review is required and block or clear release.
- `security/threat-model`: generate lightweight threat model for high-risk features.
- `security/dependency-review`: inspect dependency, package, and supply-chain changes.
- `security/secrets-permissions-review`: inspect secrets handling, permissions, auth, and data exposure.
- `security/risk-acceptance`: document accepted risk, owner, expiration, and compensating controls.

### QA

- `qa/test-plan-from-prd`: generate test plan from PRD, design handoff, security review, and implementation plan.
- `qa/pr-validation`: validate PR or release candidate and produce pass/fail report.
- `qa/regression-selection`: identify regression areas and required manual or automated tests.

### Documentation

- `docs/docs-impact`: inspect PRD/PR and identify required docs changes.
- `docs/release-notes`: draft user-facing release notes from approved PRs.
- `docs/help-update`: update or draft help docs from feature behavior and screenshots.

### DevOps

- `devops/deployment-readiness`: review infra, config, migration, and release risks.
- `devops/rollback-plan`: generate rollback and verification plan for risky releases.
- `devops/incident-followup`: convert incident notes into remediation tasks and runbook updates.

### Professional Services

- `services/customer-impact-review`: map feature or change to customer enablement implications.
- `services/implementation-readiness`: produce rollout checklist for customer-facing delivery.
- `services/feedback-to-product`: convert customer feedback into structured product intake.

## Security Gate Triggers

Security review is required for changes involving:

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
- Any PR label: `security-review`, `release-risk`, `customer-data`, `auth`

Medium or high risk changes require security approval or documented risk acceptance before merge or release.

## GitHub Labels

Use these labels to route work and trigger review expectations:

- `archon-ready`
- `needs-product`
- `needs-design`
- `needs-qa`
- `needs-security`
- `needs-devops`
- `customer-impact`
- `release-risk`
- `security-review`
- `customer-data`
- `auth`

## Pilot Success Criteria

- At least five real tickets run through Archon.
- Every run produces complete artifacts without manual reconstruction.
- PRs include implementation, QA, security, docs, and release context.
- Security gate catches or explicitly clears risky changes.
- No workflow bypasses required human approval gates.

## Validation

Run:

```bash
bun run cli validate workflows
bun run cli validate commands
```

Then pilot one low-risk request through the full chain:

1. `product-intake-to-prd`
2. `design-brief-to-handoff`
3. `development-plan-to-pr`
4. `security-risk-gate`
5. `qa-pr-validation`
6. `docs-impact-and-release-notes`
7. `devops-release-readiness`
8. `services-customer-readiness`

