# Secure Coding Guidelines — [Project Name]

**NIST 800-218**: PW.5.1 (Secure Coding Practices)
**Created**: [DATE]
**Last Updated**: [DATE]

---

## Input Validation

<!-- TODO: Define input validation requirements -->
- Validate all external inputs
- Use allowlists over denylists
- Sanitize inputs before use in queries, commands, or file paths

## Secrets Management

<!-- TODO: Define secrets management requirements -->
- Never hardcode secrets, tokens, or credentials
- Use secrets management service (e.g., AWS Secrets Manager, SSM Parameter Store)
- Rotate secrets on defined schedule

## Error Handling

<!-- TODO: Define error handling requirements -->
- Never expose stack traces or internal details in responses
- Log errors with structured format and correlation IDs
- Use dead letter queues for async failure handling

## Dependency Management

<!-- TODO: Define dependency management requirements -->
- Pin dependency versions
- Scan for known CVEs at build time
- Review updates before merging

## IAM & Access Control

<!-- TODO: Define access control requirements -->
- Follow least-privilege principle
- No wildcard actions in IAM policies
- Scope resource ARNs to specific resources

## Encryption

<!-- TODO: Define encryption requirements -->
- Encrypt all data at rest
- Enforce TLS 1.2+ for data in transit
- Use managed key services for key management

## Logging & Audit

<!-- TODO: Define logging requirements -->
- Log all security-relevant events
- Include correlation IDs
- Never log secrets, tokens, or PII

## Enforcement

| Guideline | Tool | Enforcement Level |
|-----------|------|-------------------|
| <!-- TODO: Map guidelines to enforcement tools --> | | |
