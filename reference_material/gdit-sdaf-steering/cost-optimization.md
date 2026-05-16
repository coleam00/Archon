---
inclusion: always
enforcement: mandatory
---

# Cost Optimization Standards

## Context

This steering file enforces FinOps cost considerations at design time. Infrastructure must be right-sized by default, not optimized after deployment. Every design that includes cloud resources must justify tier selection, define cost boundaries, and avoid known anti-patterns.

**NIST 800-218 Alignment**: PW.1 — Design Software to Meet Security Requirements extends to cost requirements. Over-provisioned resources increase attack surface (unused capacity, unnecessary network exposure) and waste budget that could fund security controls.

## Enforcement

**Configuration**: Controlled by `finops.enabled` in `project.yaml` (default: `true`). When `false`, the agent skips Cost Profile requirements and `validate-spec.py` skips the cost profile check.

### Cost Profile Requirement

When `design.md` includes infrastructure resources (DynamoDB, Lambda, S3, RDS, EC2, ECS, CloudFront, API Gateway, etc.), the design MUST include a **Cost Profile** table:

| Field                  | Required | Description                                                           |
| ---------------------- | -------- | --------------------------------------------------------------------- |
| Resource               | Yes      | AWS resource type and logical name                                    |
| Tier/Class             | Yes      | Compute tier, storage class, or capacity mode selected                |
| Estimated Monthly Cost | Yes      | Cost range at expected usage (e.g., $5–15/month)                      |
| Cost Driver            | Yes      | What drives cost for this resource (invocations, storage, throughput) |
| Right-Sizing Rationale | Yes      | Why this tier was chosen over cheaper alternatives                    |

Example:

```markdown
**Cost Profile:**

| Resource           | Tier/Class    | Est. Monthly Cost | Cost Driver      | Right-Sizing Rationale                                                        |
| ------------------ | ------------- | ----------------- | ---------------- | ----------------------------------------------------------------------------- |
| UserData DynamoDB  | On-Demand     | $5–15             | Read/write units | Unpredictable access pattern; provisioned would over-provision at low traffic |
| ApiResolver Lambda | 256MB / arm64 | $1–5              | Invocation count | Profiled at 128MB (OOM), 256MB sufficient with 50ms avg duration              |
| Assets S3          | Standard-IA   | $2–8              | Storage volume   | Assets accessed <1x/month after initial upload; Standard wastes 40%           |
```

### Cost Correctness Properties

Design sections with infrastructure MUST include at least one cost correctness property. These are assertions the implementation must satisfy:

- Capacity mode justified with usage data or access pattern analysis
- Lifecycle policies defined for all storage resources (S3, CloudWatch Logs, ECR)
- Concurrency/scaling limits set (Lambda reserved concurrency, auto-scaling min/max)
- No open-ended scaling without budget alarms (CloudWatch Billing alarm or AWS Budgets)
- Retention periods defined for logs and temporary data

Example:

```markdown
**Cost Correctness Properties:**

- DynamoDB uses on-demand mode (access pattern is unpredictable, <100 RCU/WCU average)
- S3 bucket has lifecycle policy: transition to Standard-IA after 30 days, Glacier after 90 days
- Lambda concurrency capped at 50 (prevents runaway invocations from costing >$100/month)
- CloudWatch Logs retention set to 90 days (not indefinite)
```

### Cost Tags on IaC Resources

ALL infrastructure resources defined in IaC templates MUST include these tags:

| Tag           | Required | Description                  |
| ------------- | -------- | ---------------------------- |
| `CostCenter`  | Yes      | Budget allocation identifier |
| `Environment` | Yes      | dev / staging / prod         |
| `Project`     | Yes      | Project or feature name      |

The agent MUST add these tags when generating IaC templates. Missing cost tags are a BLOCKING finding.

### Anti-Patterns

The agent MUST flag these cost anti-patterns during design. Using an anti-pattern without documented justification is BLOCKING.

| Anti-Pattern                                  | Preferred Alternative                         | Typical Savings                |
| --------------------------------------------- | --------------------------------------------- | ------------------------------ |
| NAT Gateway for S3/DynamoDB access            | VPC Gateway Endpoints (free)                  | ~$32/month per NAT             |
| Provisioned DynamoDB without usage data       | On-Demand until access patterns established   | Variable                       |
| S3 Standard for infrequently accessed data    | S3 Standard-IA or Intelligent-Tiering         | 40–60%                         |
| CloudWatch Logs without retention policy      | Set retention (30/90/365 days per data class) | Unbounded → bounded            |
| Lambda at max memory without profiling        | Right-size with AWS Lambda Power Tuning       | 20–60%                         |
| RDS Multi-AZ in dev/staging                   | Single-AZ for non-production                  | ~50%                           |
| Dedicated NAT Gateway per subnet              | Shared NAT Gateway per AZ                     | 50–66%                         |
| EBS gp3 at default IOPS for batch workloads   | Reduce IOPS to minimum (3000) if not IO-bound | 10–30%                         |
| CloudFront with default TTL for static assets | Increase TTL to 86400+ for immutable assets   | Reduced origin requests        |
| Separate DynamoDB tables for related data     | Single-table design with GSIs                 | Fewer tables to manage/pay for |

### Environment-Appropriate Sizing

Non-production environments MUST use reduced capacity unless testing requires production-equivalent load:

| Resource    | Production                      | Dev/Staging                         |
| ----------- | ------------------------------- | ----------------------------------- |
| RDS         | Multi-AZ, larger instance       | Single-AZ, smallest viable instance |
| DynamoDB    | Provisioned (if patterns known) | On-Demand                           |
| Lambda      | Production concurrency limits   | Lower concurrency, same memory      |
| ElastiCache | Cluster mode                    | Single node                         |
| NAT Gateway | Per-AZ for HA                   | Single NAT or VPC endpoints only    |

## References

- AWS Well-Architected Framework — Cost Optimization Pillar
- FinOps Foundation — FinOps Principles (Inform, Optimize, Operate)
- AWS Pricing: agent uses general pricing knowledge for estimates, not API calls
- For precise estimates, direct users to AWS Pricing Calculator
