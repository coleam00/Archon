---
inclusion: conditional
enforcement: mandatory
---

# Well-Architected Framework Alignment

**Configuration**: Controlled by `well-architected.enabled` in `project.yaml` (default: `true`). When `false`, this steering file is not loaded, the agent skips WAF design-time assessment, and `validate-spec.py` skips the WAF assessment check.

## Context

All infrastructure designs and IaC files must be assessed against the AWS Well-Architected Framework six pillars. This assessment happens at two points: proactively during design and reactively after IaC modification.

## Design-Time Assessment

When design.md includes an infrastructure resources table, the agent MUST generate a **Well-Architected Assessment** table mapping each resource to applicable WAF pillars:

```markdown
**Well-Architected Assessment:**

| Resource        | Pillar                 | Assessment                     | Status     |
| --------------- | ---------------------- | ------------------------------ | ---------- |
| DynamoDB Table  | Reliability            | Point-in-time recovery enabled | ✅ Aligned |
| DynamoDB Table  | Cost Optimization      | Capacity mode not evaluated    | ⚠️ Review  |
| Lambda Function | Operational Excellence | No X-Ray tracing configured    | ❌ Gap     |
```

**Status Values:**

- ✅ Aligned — design explicitly addresses the pillar concern
- ⚠️ Review — pillar concern not addressed but may be intentional
- ❌ Gap — design contradicts or omits a WAF best practice

**Pillar Assessment Criteria:**

| Pillar                 | Key Checks                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------- |
| Operational Excellence | Monitoring, tracing (X-Ray), structured logging, runbook references                    |
| Security               | Encryption at rest/transit, least-privilege IAM, network isolation, secrets management |
| Reliability            | Multi-AZ, backup/DR strategy, auto-scaling, retry/circuit-breaker patterns             |
| Performance Efficiency | Right-sized compute, caching strategy, async processing where appropriate              |
| Cost Optimization      | Cost allocation tags, capacity mode evaluation, lifecycle policies                     |
| Sustainability         | Right-sized resources, managed services over self-hosted where equivalent              |

The assessment is ADVISORY — gaps and review items do not block implementation but are captured in the spec for traceability and audit.

## Post-IaC WAF Validation

After IaC files are modified, the agent runs WAF-aligned cfn-guard rules from `.kiro/config/cfn-guard-waf-rules.guard` as part of the existing IaC validation pipeline:

```bash
cfn-guard validate --data <file> --rules .kiro/config/cfn-guard-waf-rules.guard
```

These rules complement the existing NIST/CIS rules in `cfn-guard-rules.guard` and cover:

- **Reliability**: DynamoDB PITR, RDS Multi-AZ, S3 versioning
- **Operational Excellence**: Lambda X-Ray tracing, CloudWatch log retention
- **Cost Optimization**: Cost allocation tags on all resources
- **Security**: S3 encryption, RDS encryption at rest

WAF cfn-guard findings are ADVISORY (WARN severity) — they surface gaps without blocking deployment.

## Existing Specs

When `well-architected.enabled` is set to `true` on a project with existing specs, `validate-spec.py` will emit WARN for infrastructure specs missing the WAF assessment table. These warnings are advisory — existing specs do not need immediate backfill. The agent adds the WAF assessment table when a spec is next modified. The same applies to `finops.enabled` and the Cost Profile table.

## References

- AWS Well-Architected Framework: https://docs.aws.amazon.com/wellarchitected/latest/framework/
- AWS Well-Architected Tool: https://aws.amazon.com/well-architected-tool/
