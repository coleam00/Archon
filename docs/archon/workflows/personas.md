# Cross-Functional Workflow Personas

This guide describes the people who use the Archon product-team workflow customization, what they care about, and which workflows they own.

## Persona Summary

| Persona | Primary Goal | Main Workflows | Owns |
|---------|--------------|----------------|------|
| Product Manager | Define valuable, scoped work | `product-intake-to-prd` | PRD, scope, success metrics |
| Product Designer | Make the experience buildable and testable | `design-brief-to-handoff` | UX brief, handoff, design approval |
| Developer | Turn approved scope into safe changes | `development-plan-to-pr` | Implementation, validation evidence, PR |
| QA Engineer | Prove the change works and does not regress | `qa-pr-validation` | Test plan, validation report, defects |
| Security Reviewer | Clear or block risky changes | `security-risk-gate` | Security review, threat model, risk acceptance |
| Technical Writer | Make the change understandable | `docs-impact-and-release-notes` | Docs impact, help updates, release notes |
| DevOps / Release Engineer | Make deployment reversible and observable | `devops-release-readiness` | Deployment plan, rollback plan, monitoring notes |
| Professional Services | Prepare customers and delivery teams | `services-customer-readiness` | Customer impact, enablement, rollout checklist |
| Product / Engineering Lead | Keep the process healthy | All workflows | Governance, prioritization, final readiness |

## Product Manager

### Jobs To Be Done

- Convert ambiguous requests into clear product decisions.
- Define the problem, target user, success metrics, and v1 scope.
- Decide what is explicitly out of scope.
- Approve the PRD before design or build work proceeds.

### Workflows

- Starts with `product-intake-to-prd`.
- Uses `product-scope-change-review` when scope changes midstream.

### Artifacts Owned

- `$ARTIFACTS_DIR/product/requirements.md`
- `$ARTIFACTS_DIR/product/prd.md`
- `$ARTIFACTS_DIR/product/decision-log.md`

### Good Inputs

- GitHub issue or customer request
- Target user
- Business outcome
- Evidence or examples
- Constraints and deadlines

### Approval Responsibility

Product approval means:

- The problem is real enough to pursue.
- The proposed scope is acceptable.
- Success criteria are measurable.
- Open questions are either resolved or explicitly accepted.

## Product Designer

### Jobs To Be Done

- Convert approved scope into a usable experience.
- Identify user flows, states, copy, accessibility expectations, and design risks.
- Make design handoff concrete enough for engineering and QA.

### Workflows

- Runs `design-brief-to-handoff` after PRD approval.
- Uses `design-ui-review` during PR review or feature validation.

### Artifacts Owned

- `$ARTIFACTS_DIR/design/design-brief.md`
- `$ARTIFACTS_DIR/design/handoff.md`
- `$ARTIFACTS_DIR/design/ux-review.md`

### Good Inputs

- Approved PRD
- Existing UI patterns
- Screenshots or design links
- Accessibility constraints
- Known edge cases

### Approval Responsibility

Design approval means:

- Required flows and states are described.
- Accessibility expectations are clear.
- Engineering has enough detail to build.
- QA has enough detail to test the experience.

## Developer

### Jobs To Be Done

- Convert approved scope into code.
- Keep implementation isolated in a worktree.
- Run validation and create a reviewable PR.
- Produce an implementation report for QA, security, docs, DevOps, and services.

### Workflows

- Runs `development-plan-to-pr`.
- May use existing Archon defaults such as `archon-plan-to-pr`, `archon-fix-github-issue`, or `archon-refactor-safely` for engineering-specific work.

### Artifacts Owned

- `$ARTIFACTS_DIR/development/implementation-plan.md`
- `$ARTIFACTS_DIR/development/implementation-report.md`
- PR summary and validation evidence

### Good Inputs

- Approved PRD
- Design handoff
- Security constraints
- Acceptance criteria
- Existing tests and validation commands

### Approval Responsibility

Build approval means:

- Scope is understood.
- Non-scope is explicit.
- Validation path is known.
- Risks are documented before editing begins.

## QA Engineer

### Jobs To Be Done

- Convert requirements and implementation details into a test plan.
- Select regression areas.
- Record validation evidence.
- Approve or block release candidate readiness.

### Workflows

- Runs `qa-pr-validation`.
- Uses `qa-regression-selection` for targeted regression planning.

### Artifacts Owned

- `$ARTIFACTS_DIR/qa/test-plan.md`
- `$ARTIFACTS_DIR/qa/regression-selection.md`
- `$ARTIFACTS_DIR/qa/validation-report.md`

### Good Inputs

- PRD
- Design handoff
- Implementation report
- Security review
- PR link
- Test environment details

### Approval Responsibility

QA approval means:

- Critical scenarios were tested or explicitly marked untested.
- Defects are documented.
- Release recommendation is clear.
- Untested risk is visible to product and release owners.

## Security Reviewer

### Jobs To Be Done

- Classify security risk.
- Inspect triggered security areas.
- Require fixes, approve release, or document risk acceptance.
- Prevent risky changes from merging silently.

### Workflows

- Runs `security-risk-gate`.
- Uses security commands for threat modeling, dependency review, secrets review, and risk acceptance.

### Artifacts Owned

- `$ARTIFACTS_DIR/security/security-review.md`
- `$ARTIFACTS_DIR/security/threat-model.md`
- `$ARTIFACTS_DIR/security/dependency-review.md`
- `$ARTIFACTS_DIR/security/secrets-permissions-review.md`
- `$ARTIFACTS_DIR/security/risk-acceptance.md`
- `$ARTIFACTS_DIR/security/security-signoff.md`

### Good Inputs

- PR link or diff
- PRD
- Implementation report
- Dependency changes
- Data-flow description
- Auth and permission changes

### Approval Responsibility

Security approval means:

- Security triggers were reviewed.
- Risk level is documented.
- Required fixes are complete or tracked.
- Accepted risk has an owner, expiration, and compensating controls.

## Technical Writer

### Jobs To Be Done

- Determine whether docs are required.
- Draft user-facing updates and release notes.
- Keep docs aligned with actual behavior.

### Workflows

- Runs `docs-impact-and-release-notes`.

### Artifacts Owned

- `$ARTIFACTS_DIR/docs/docs-impact.md`
- `$ARTIFACTS_DIR/docs/user-guide-delta.md`
- `$ARTIFACTS_DIR/docs/release-notes.md`

### Good Inputs

- PRD
- Design handoff
- Implementation report
- QA validation report
- Screenshots or examples
- Known limitations

### Approval Responsibility

Docs approval means:

- Required docs updates are identified.
- Release notes are customer-safe.
- Migration or action-required notes are explicit.
- Known limitations are not hidden.

## DevOps / Release Engineer

### Jobs To Be Done

- Confirm deployment readiness.
- Identify migration, configuration, observability, and rollback risks.
- Make production deployment reversible.

### Workflows

- Runs `devops-release-readiness`.
- Uses `devops-incident-followup` after incidents.

### Artifacts Owned

- `$ARTIFACTS_DIR/devops/deployment-plan.md`
- `$ARTIFACTS_DIR/devops/rollback-plan.md`
- `$ARTIFACTS_DIR/devops/infra-risk-review.md`
- `$ARTIFACTS_DIR/devops/incident-followup.md`

### Good Inputs

- PR link
- Implementation report
- Security signoff
- QA validation report
- Migration details
- Config or infrastructure changes

### Approval Responsibility

DevOps approval means:

- Deployment steps are known.
- Rollback path is documented.
- Monitoring and alerting are sufficient.
- Operational blockers are resolved or accepted.

## Professional Services

### Jobs To Be Done

- Translate product changes into customer rollout readiness.
- Prepare enablement notes and implementation checklists.
- Feed customer findings back to product.

### Workflows

- Runs `services-customer-readiness`.
- Uses `services-feedback-to-product` to convert field feedback into product intake.

### Artifacts Owned

- `$ARTIFACTS_DIR/services/customer-impact.md`
- `$ARTIFACTS_DIR/services/implementation-readiness.md`
- `$ARTIFACTS_DIR/services/feedback-to-product.md`

### Good Inputs

- Release notes
- PRD
- QA validation
- Deployment plan
- Known limitations
- Customer segment impact

### Approval Responsibility

Services approval means:

- Customer-facing impact is understood.
- Enablement and rollout notes are ready.
- Support or implementation risks are visible.
- Customer communication needs are captured.

## Product / Engineering Lead

### Jobs To Be Done

- Keep the workflow system useful rather than bureaucratic.
- Resolve cross-functional conflicts.
- Decide which gates are required for each class of work.
- Review workflow quality after pilot tickets.

### Workflows

- Reviews output from all workflows.
- Owns final readiness when a change spans multiple functions.

### Artifacts Used

- PR template signoff section
- All linked Archon artifacts
- Pilot retrospective notes

### Approval Responsibility

Lead approval means:

- Required function gates are complete or explicitly marked not needed.
- Release risks are visible.
- The team has enough evidence to merge or ship.

## Persona Handoff Map

| From | To | Handoff Artifact | Success Condition |
|------|----|------------------|-------------------|
| Product | Design | `prd.md` | Problem, goals, and scope are clear |
| Product | Development | `prd.md`, `decision-log.md` | Acceptance criteria are buildable |
| Design | Development | `design-brief.md`, `handoff.md` | UX states and flows are ready |
| Development | Security | `implementation-report.md`, PR diff | Security triggers are inspectable |
| Development | QA | `implementation-report.md`, PR diff | Test scope is clear |
| Security | QA | `security-signoff.md` | Security-sensitive cases are known |
| QA | Docs | `validation-report.md` | Actual behavior and limitations are clear |
| Docs | Services | `release-notes.md`, `user-guide-delta.md` | Customer-facing language is ready |
| DevOps | Services | `deployment-plan.md`, `rollback-plan.md` | Rollout constraints are known |
| Services | Product | `feedback-to-product.md` | Customer feedback becomes actionable intake |

## How Personas Should Improve The System

Each persona owns the quality of their artifacts and commands. During the pilot, every function should capture:

- One artifact field that was missing.
- One prompt instruction that was unclear.
- One approval gate that was too early, too late, or unnecessary.
- One workflow shortcut that would help low-risk work.

Update workflow and command files through pull requests so the process stays explicit and reviewable.

