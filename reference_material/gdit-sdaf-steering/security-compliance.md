---
inclusion: always
enforcement: mandatory
---

# Security and Compliance Standards

Reference examples: `~/.kiro/steering/security-compliance-reference.md`

## Context

This steering file enforces OWASP compliance, NIST/FedRAMP security requirements, and security best practices for all code generation and infrastructure development. It automatically injects security controls and validates against security standards to prevent common vulnerabilities.

**NIST 800-218 Compliance**: This steering file implements NIST SP 800-218 (Secure Software Development Framework) practice **PW.1: Design Software to Meet Security Requirements** by enforcing security controls at design time through mandatory, automatic injection during all code generation and infrastructure development.

## NIST 800-218 Alignment

This steering file satisfies the following SSDF practices:

**PW.1 - Design Software to Meet Security Requirements**

- Security requirements automatically enforced during code generation
- Mandatory compliance with OWASP Top 10, NIST 800-171, FedRAMP controls
- Design-time validation prevents security issues before implementation

**PW.4 - Review and/or Analyze Human-Readable Code**

- Gitleaks scans for hardcoded secrets and sensitive data
- Code quality validation and linting enforcement
- Proper error handling requirements

**PW.7 - Review and/or Analyze Software**

- Security scanning requirements (GitLeaks, Semgrep, Trivy, Checkov, KICS, Ruff)
- Compliance validation against security standards
- Infrastructure security validation
- Lambda IAM role uniqueness enforcement (KICS)

The compliance pattern catalog (`~/.kiro/steering/compliance-pattern-catalog.md`) is the validation reference for implementation pattern to NIST control mappings. The authoritative compliance mapping lives in each spec's `model.sysml` `package ComplianceGraph` block.

## Enforcement

### OWASP Input Validation Rule (MANDATORY - BLOCKING)

All inputs MUST be validated before use. No exceptions. This applies to every function, method, handler, or entry point that receives external data.

**Rule**: Every parameter, argument, event field, query parameter, header, body payload, file upload, environment variable read, or user-supplied value MUST be validated (type, format, length, range, allowlist) BEFORE it is used in any logic, query, command, file operation, or output.

**Applies to**:

- Lambda event payloads (API Gateway, SQS, SNS, EventBridge, S3, etc.)
- CLI arguments and script parameters
- HTTP request bodies, headers, query strings, path parameters
- File contents and filenames
- Environment variables used as configuration
- Database query results used in subsequent operations
- Deserialized JSON/YAML/XML data

**Violations that BLOCK**:

- Using `event['body']` or `event['queryStringParameters']` without validation
- Passing user input directly to SQL, shell commands, file paths, or HTML output
- Trusting deserialized data without schema/type validation
- Using environment variables in security-sensitive operations without validation

**OWASP Reference**: A03:2021 Injection, A04:2021 Insecure Design

### Input Validation and Sanitization

When generating any code that handles user input:

- **Always validate input** at entry points using allowlists, not blocklists
- **Sanitize output** based on context (HTML encoding, SQL parameterization, etc.)
- **Implement proper error handling** that doesn't leak sensitive information
- **Use parameterized queries** for all database interactions
- **Validate file uploads** with type checking, size limits, and malware scanning
- **Prevent SSRF attacks** by validating URLs and restricting outbound requests
- **Implement rate limiting** to prevent abuse and DoS attacks
- **Configure CORS properly** with specific origins, not wildcards

### Authentication and Authorization

When implementing authentication systems:

- **Use established libraries** (OAuth 2.0, SAML, JWT with proper validation)
- **Implement proper session management** with secure tokens and timeouts
- **Enforce principle of least privilege** for all access controls
- **Use multi-factor authentication** for administrative access
- **Implement proper password policies** with hashing (bcrypt, Argon2)

### Secrets Management

When handling sensitive data:

- **Never hardcode secrets** in source code or configuration files
- **Use AWS Secrets Manager or Parameter Store** for secret storage
- **Rotate secrets regularly** with automated rotation where possible
- **Use environment variables** for configuration, not embedded secrets
- **Implement proper key management** with AWS KMS for encryption keys

### Data Protection

For all data handling:

- **Enable encryption at rest** using AES-256 minimum key strength for all data stores (S3, RDS, DynamoDB, EBS)
- **Use FIPS 140-2/3 validated cryptographic modules** when protecting CUI (per ITHB501C §3.13, NIST 800-171 Rev 2 SC.L2-3.13.11)
- **Enable encryption in transit** using TLS 1.2+ for all communications
- **Implement proper backup strategies** with encryption and retention policies
- **Use VPC endpoints** for AWS service access to avoid internet exposure
- **Enable CloudTrail logging** for all API calls and data events
- **Audit log retention**: 90-day minimum for application logs, 365-day minimum for security and audit logs (per ITHB501C §3.3)
- **Apply data masking** to sensitive data in non-production environments when shared with third parties (per IT-STD-50-11 §4.1.9)

### Infrastructure Security

When creating AWS infrastructure:

- **Use IAM roles** instead of access keys where possible
- **Implement least privilege IAM policies** with specific resource ARNs
- **Configure VPC security groups** with minimal required access
- **Enable AWS Config** for compliance monitoring
- **Implement network segmentation** with proper subnet isolation
- **Use AWS Systems Manager Session Manager** instead of SSH where possible

### Compliance Standards

All implementations must validate against:

- **OWASP Top 10** vulnerability prevention
- **NIST Cybersecurity Framework** controls where applicable
- **NIST 800-171** security requirements for controlled unclassified information (CUI)
- **NIST 800-171 Rev 2** alignment per ITPOL50 Cyber Security Policy
- **FedRAMP security controls** for government systems
- **SOC 2 Type II** requirements for data handling
- **GDPR/CCPA** privacy requirements for personal data
- **AWS Well-Architected Framework** security pillar

### Secret Detection and Code Quality

When reviewing code files:

- **Check `security.enabled-scanners`** in `project.yaml` — only run listed scanners (default: all)
- **Check `security.semgrep.severity-levels`** — use configured severity flags (default: ERROR, WARNING)
- **Check `security.trivy.severity-levels`** — use configured severity flags (default: HIGH, CRITICAL)
- **Run gitleaks scans** to detect hardcoded secrets, API keys, and sensitive data
- **Validate CloudFormation syntax** using cfn-lint for template correctness
- **Enforce security policies** using cfn-guard for compliance validation
- **Run security analysis** using checkov for infrastructure security scanning (policy-as-code)
- **Run KICS scans** for complementary IaC security (OPA-based rules, Lambda unique role enforcement)
- **Validate syntax and formatting** using appropriate linters for the language
- **Check for code quality issues** and adherence to language-specific best practices
- **Ensure proper error handling** that doesn't expose system internals

### AWS Credential Handling

When handling AWS credentials in code or reports:

- **NEVER store full AWS access keys** - triggers Gitleaks detection
- **Mask access key IDs** - show only last 4 characters (e.g., \*\*\*\*KZ6G)
- **Never include AKIA prefix** - primary Gitleaks detection pattern
- **Use AWS CLI profiles** - for AWS credential management (not hardcoded keys)
- **Save sensitive reports to temp/** - git-ignored directory
- **Validate output** - ensure no AKIA patterns before committing

### Security Tool Configuration

Security scanning tools are configured in `.kiro/config/`:

- **CFN-Guard Rules**: `.kiro/config/cfn-guard-rules.guard` - Compliance validation rules
- **CFN-Lint Custom Rules**: `.kiro/config/cfn-lint-custom-rules.txt` - Custom governance rules
- **CFN-Lint Configuration**: `.kiro/config/cfn-lint-config.yaml` - Validation configuration

## Compliance Documentation Requirements

For all infrastructure resources:

- **Document compliance mappings** to NIST/FedRAMP controls
- **Include security justifications** for configuration choices
- **Specify data classification** levels (public, internal, sensitive, restricted)
- **Define backup and disaster recovery** procedures
- **Maintain audit trail** of security-related changes

## Security Review Checklist

Before deploying any code or infrastructure:

- [ ] **All inputs validated before use** (OWASP A03 - BLOCKING)
- [ ] Input validation implemented with allowlists
- [ ] Output sanitization appropriate for context
- [ ] Parameterized queries used for all database access
- [ ] Secrets stored in AWS Secrets Manager/Parameter Store
- [ ] Encryption at rest enabled for all data stores
- [ ] Encryption in transit using TLS 1.2+
- [ ] IAM policies follow least privilege principle
- [ ] Security groups configured with minimal access
- [ ] CloudTrail logging enabled
- [ ] Compliance tags applied to all resources
- [ ] Gitleaks scan completed with no findings
- [ ] CloudFormation syntax validated with cfn-lint
- [ ] Compliance rules enforced with cfn-guard
- [ ] Security scan completed with checkov
- [ ] Code quality validation passed
- [ ] Ruff lint check completed for Python files
- [ ] dotnet-format check completed for C# files
