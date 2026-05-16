# Design & Code Review Policy — [Project Name]

**NIST 800-218**: PW.2.1 (Design Review), PW.7.1 (Code Review)
**Created**: [DATE]
**Last Updated**: [DATE]

---

## When Review Is Required

| Change Type | Review Type | Minimum Reviewers | Approval Required |
|-------------|------------|-------------------|-------------------|
| <!-- TODO: Define review requirements per change type --> | | | |

## Review Checklist

- [ ] Input validation present for all external data
- [ ] No hardcoded secrets or credentials
- [ ] IAM permissions follow least privilege
- [ ] Error handling does not expose internals
- [ ] Logging includes correlation IDs
- [ ] Encryption enforced for data at rest and in transit
- [ ] <!-- TODO: Add project-specific checklist items -->

## Automated vs. Manual Review

| Scenario | Automated Sufficient | Manual Required |
|----------|---------------------|----------------|
| <!-- TODO: Define when automated-only is acceptable --> | | |

## Recording & Tracking

<!-- TODO: Define how review findings are recorded (issue tracker, MR comments, etc.) -->

## Escalation

<!-- TODO: Define escalation path for unresolved review findings -->
