---
inclusion: fileMatch
fileMatchPattern: '*.{yaml,yml,json,tf,py,ts,js,bicep}'
enforcement: mandatory
---

# Infrastructure Standards

Reference examples: `~/.kiro/steering/infrastructure-standards-reference.md`

## Context

This steering file enforces Infrastructure as Code (IaC) compliance, multi-cloud integration patterns, and prevents manual resource modifications. It ensures all infrastructure changes go through proper IaC workflows using official tools and validation.

## Enforcement

### Specification-Driven Infrastructure

When creating infrastructure:

- **Document in design.md** - Infrastructure resources table with purpose, compliance, backup strategy
- **Define in tasks.md** - Infrastructure deployment tasks with validation steps
- **Reference requirements** - Link infrastructure to business requirements
- **Follow spec workflow** - Requirements → Design → Tasks pattern for all infrastructure changes

### IaC-Only Infrastructure Changes

When working with cloud infrastructure:

- **Use IaC tools** for all infrastructure definitions (CloudFormation, CDK, Terraform, Bicep, etc.)
- **Never create resources manually** through cloud consoles or CLI
- **Version control all infrastructure code** with proper branching strategies
- **Use appropriate tools** for infrastructure operations and validation
- **Document all infrastructure decisions** in design specifications

### Infrastructure File Organization

All IaC files must follow project-organization.md standards:

- **CloudFormation/SAM**: `infrastructure/cloudformation/` or `infrastructure/sam/`
- **CDK**: `infrastructure/cdk/`
- **Terraform**: `infrastructure/terraform/`
- **Bicep**: `infrastructure/bicep/`
- **ARM Templates**: `infrastructure/arm/`
- **Pulumi**: `infrastructure/pulumi/`
- **Ansible**: `infrastructure/ansible/`

### Supported IaC Tools

#### AWS

- **CloudFormation** - Native AWS IaC, YAML/JSON templates
- **SAM (Serverless Application Model)** - Extends CloudFormation for serverless applications
- **CDK (Cloud Development Kit)** - TypeScript, Python, Java, C#, Go

#### Azure

- **Bicep** - Azure-native declarative language
- **ARM Templates** - Azure Resource Manager JSON templates
- **Terraform** - Multi-cloud support including Azure

#### Google Cloud

- **Deployment Manager** - Google Cloud native IaC
- **Terraform** - Multi-cloud support including GCP

#### Configuration Management

- **Ansible** - Agentless automation and configuration management (YAML playbooks)

#### Multi-Cloud

- **Terraform** - HashiCorp's multi-cloud IaC tool
- **Pulumi** - Modern IaC with TypeScript, Python, Go, C#, Java
- **Crossplane** - Kubernetes-based multi-cloud control plane

### Security and Compliance Requirements

ALL infrastructure resources MUST comply with:

- **NIST 800-171**, **CIS Benchmarks**, **FedRAMP** (where applicable)
- **AWS Well-Architected Security Pillar**, **Azure Security Benchmark**, **GCP Security Best Practices**

**Configuration Requirements:**

- **Encryption at Rest** - All data stores MUST use encryption
- **Encryption in Transit** - All communications MUST use TLS 1.2+
- **Least Privilege IAM** - All IAM/RBAC policies MUST use specific resource identifiers, not wildcards
- **Network Isolation** - Resources MUST use VPC/VNet with proper security groups/NSGs
- **Logging Enabled** - CloudTrail/Azure Monitor/Cloud Logging MUST be enabled
- **Public Access Blocked** - Storage buckets, databases MUST block public access by default
- **Backup Enabled** - Critical resources MUST have automated backup strategies
- **Compliance Tags** - All resources MUST include compliance tags (Compliance, DataClassification)

**Validation:**

- cfn-guard rules enforce NIST 800-171 and CIS controls
- checkov scans validate security best practices across all clouds
- All findings MUST be resolved before deployment

**Zero-Findings Policy:**
Infrastructure deployments MUST NOT create findings for Security Hub, Defender for Cloud, Security Command Center, or NIST 800-171 requirements.

See security-compliance.md for detailed security requirements.

### AWS MCP Tool Usage

- **API Operations**: `awslabs.aws-api-mcp-server`
- **Documentation**: `awslabs.aws-documentation-mcp-server`
- **Infrastructure**: `awslabs.aws-iac-mcp-server` and `awslabs.cfn-mcp-server`
- **Monitoring**: `awslabs.cloudwatch-mcp-server`
- **Serverless**: `awslabs.aws-serverless-mcp-server`
- **Diagrams**: `awslabs.aws-diagram-mcp-server`
- **Security**: `awslabs.well-architected-security-mcp-server`

### Authentication and Configuration

- **Use AWS profiles** configured in MCP server environment variables
- **Leverage IAM roles** instead of access keys where possible
- **Configure proper SSL certificates** for corporate environments
- **Use consistent AWS regions** across related services

### Infrastructure Security Scanning

Before deploying infrastructure:

- **cfn-lint** - Validate CloudFormation/SAM syntax and best practices
- **cfn-guard** - Enforce compliance rules from .kiro/config/cfn-guard-rules.guard
- **checkov** - Security scanning for all IaC files (policy-as-code)
- **KICS** - Complementary IaC security scanner (OPA-based, Lambda unique roles)
- **tfsec** - Terraform-specific security scanning
- **ansible-lint** - Ansible playbook linting and best practices
- **Azure Policy** - Compliance validation for Azure resources

### Cloud-Specific Validation Tools

| Cloud       | Tools                                                                          |
| ----------- | ------------------------------------------------------------------------------ |
| AWS         | cfn-lint, cfn-guard, checkov, KICS, AWS CLI validate-template                  |
| Azure       | bicep build, az deployment validate, checkov, Azure Policy                     |
| GCP         | gcloud deployment-manager validate, checkov, terraform validate                |
| Multi-Cloud | terraform validate/plan, tfsec, checkov, pulumi preview                        |
| Ansible     | ansible-lint, checkov (`--framework ansible`), ansible-playbook --syntax-check |

### Infrastructure Resource Documentation

ALL cloud resources MUST be documented in the corresponding feature's design.md file.

**Template File Reference Requirement:**

- design.md MUST document WHAT resources exist and WHERE (template filename + path)
- tasks.md MUST document HOW to deploy (template filename + deployment command)
- MUST keep design.md and tasks.md template references synchronized

### Governance Rules

Infrastructure compliance is enforced through:

- **CFN-Guard Rules**: `.kiro/config/cfn-guard-rules.guard`
- **CFN-Lint Configuration**: `.kiro/config/cfn-lint-config.yaml`
- **Custom Governance Rules**: `.kiro/config/cfn-lint-custom-rules.txt`

### Service Integration Patterns

- **Follow Well-Architected principles** for all service combinations
- **Implement proper error handling** and retry logic
- **Configure monitoring and alerting** for all integrations
- **Document service dependencies** and data flows

### Well-Architected Framework Alignment

See `well-architected.md` steering file (loaded conditionally when `well-architected.enabled: true` in `project.yaml`).

### Infrastructure Documentation Requirements

- **Document resource purpose** and business justification
- **Include security considerations** and compliance mappings
- **Specify backup and disaster recovery** procedures
- **Define monitoring and alerting** requirements

### Cost Optimization

- **Use Cost Explorer MCP tools** to monitor and optimize costs
- **Implement proper resource tagging** for cost allocation
- **Choose appropriate instance types** and storage classes
- **Configure auto-scaling** where applicable

### Change Management

- **Create specifications first** following requirements → design → tasks pattern
- **Use pull request workflows** for all infrastructure changes
- **Require peer review** for infrastructure modifications
- **Test in non-production** environments first
- **Maintain rollback procedures** for all changes
