# Compliance Framework Mappings

Mapping of AWS Security Hub controls to compliance frameworks.

## NIST 800-53 Mappings

### Access Control (AC)
- **AC-2**: Account Management → IAM.3 (Access key rotation)
- **AC-3**: Access Enforcement → IAM.1 (Least privilege policies)
- **AC-6**: Least Privilege → IAM.1, KMS.1, KMS.2

### Audit and Accountability (AU)
- **AU-2**: Audit Events → CloudTrail.1 (Multi-region trail)
- **AU-9**: Protection of Audit Information → CloudTrail.2 (Log file validation)
- **AU-12**: Audit Generation → Config.1 (Configuration recorder)

### Configuration Management (CM)
- **CM-2**: Baseline Configuration → Config.1 (AWS Config enabled)
- **CM-8**: Information System Component Inventory → Config.1

### Identification and Authentication (IA)
- **IA-2**: Identification and Authentication → IAM.4 (No root access keys)
- **IA-5**: Authenticator Management → IAM.3 (Key rotation)

### System and Communications Protection (SC)
- **SC-7**: Boundary Protection → EC2.2 (Default security group)
- **SC-8**: Transmission Confidentiality → S3.5 (SSL/TLS required)
- **SC-13**: Cryptographic Protection → S3.4 (Encryption at rest)
- **SC-28**: Protection of Information at Rest → RDS.3 (Encryption)

## SOC 2 Mappings

### Security (CC6)
- **CC6.1**: Logical and Physical Access Controls
  - IAM.1 (Least privilege)
  - IAM.4 (No root keys)
  - S3.1 (Block public access)
  - RDS.2 (No public access)

- **CC6.6**: Logical Access - Authentication
  - IAM.3 (Key rotation)
  - IAM.4 (Root access keys)

- **CC6.7**: Logical Access - Restriction to Authorized Users
  - Lambda.1 (No public functions)
  - S3.2 (No public read)

### Availability (A1)
- **A1.2**: System Monitoring
  - CloudTrail.1 (Audit logging)
  - Config.1 (Configuration tracking)

### Confidentiality (C1)
- **C1.1**: Confidential Information Protection
  - S3.4 (Encryption at rest)
  - S3.5 (Encryption in transit)
  - RDS.3 (Database encryption)

## AWS Foundational Security Best Practices

### Identity and Access Management
- IAM.1: No full "*:*" policies
- IAM.3: Rotate access keys every 90 days
- IAM.4: No root access keys
- IAM.5: MFA for console access
- IAM.6: Hardware MFA for root

### Logging and Monitoring
- CloudTrail.1: Multi-region trail enabled
- CloudTrail.2: Log file validation enabled
- Config.1: AWS Config enabled

### Data Protection
- S3.1: Block public access enabled
- S3.2: No public read access
- S3.4: Server-side encryption enabled
- S3.5: SSL/TLS required
- RDS.3: Database encryption enabled

### Network Security
- EC2.2: Default security group restricted
- Lambda.1: No public function access
- RDS.2: No public database access

## CIS AWS Foundations Benchmark

### Section 1: Identity and Access Management
- **1.4**: Ensure access keys are rotated every 90 days → IAM.3
- **1.12**: Ensure no root account access key exists → IAM.4
- **1.16**: Ensure IAM policies are attached only to groups or roles → IAM.1

### Section 2: Logging
- **2.1**: Ensure CloudTrail is enabled in all regions → CloudTrail.1
- **2.2**: Ensure CloudTrail log file validation is enabled → CloudTrail.2
- **2.5**: Ensure AWS Config is enabled → Config.1

### Section 3: Monitoring
- **3.1-3.14**: CloudWatch alarms for various security events

### Section 4: Networking
- **4.1**: Ensure no security groups allow ingress from 0.0.0.0/0 to port 22
- **4.2**: Ensure no security groups allow ingress from 0.0.0.0/0 to port 3389
- **4.3**: Ensure default security group restricts all traffic → EC2.2

## PCI DSS Mappings

### Requirement 2: Do not use vendor-supplied defaults
- IAM.4: No root access keys
- EC2.2: Default security group restricted

### Requirement 3: Protect stored cardholder data
- S3.4: Encryption at rest
- RDS.3: Database encryption

### Requirement 4: Encrypt transmission of cardholder data
- S3.5: SSL/TLS required
- ELB.1: HTTPS listeners

### Requirement 7: Restrict access to cardholder data
- IAM.1: Least privilege policies
- S3.1: Block public access
- S3.2: No public read

### Requirement 8: Identify and authenticate access
- IAM.3: Access key rotation
- IAM.5: MFA enabled

### Requirement 10: Track and monitor all access
- CloudTrail.1: Audit logging
- Config.1: Configuration tracking

## HIPAA Mappings

### Administrative Safeguards (§164.308)
- **§164.308(a)(1)(ii)(D)**: Information System Activity Review
  - CloudTrail.1 (Audit logs)
  - Config.1 (Configuration tracking)

- **§164.308(a)(3)(i)**: Workforce Clearance Procedure
  - IAM.1 (Least privilege)
  - IAM.3 (Access review via key rotation)

- **§164.308(a)(4)(ii)(B)**: Log-in Monitoring
  - CloudTrail.1 (Authentication logging)

### Physical Safeguards (§164.310)
- **§164.310(d)(1)**: Device and Media Controls
  - S3.4 (Encryption at rest)
  - RDS.3 (Database encryption)

### Technical Safeguards (§164.312)
- **§164.312(a)(1)**: Access Control
  - IAM.1 (Unique user identification)
  - IAM.4 (No shared credentials)

- **§164.312(a)(2)(iv)**: Encryption and Decryption
  - S3.4 (Data at rest)
  - S3.5 (Data in transit)
  - RDS.3 (Database encryption)

- **§164.312(b)**: Audit Controls
  - CloudTrail.1 (Activity logging)
  - Config.1 (Configuration changes)

- **§164.312(c)(1)**: Integrity
  - CloudTrail.2 (Log file validation)

- **§164.312(e)(1)**: Transmission Security
  - S3.5 (SSL/TLS required)

## FedRAMP Mappings

### Low Impact Level
- CloudTrail.1: Audit logging
- Config.1: Configuration management
- IAM.3: Access control
- S3.5: Encryption in transit

### Moderate Impact Level
All Low controls plus:
- IAM.1: Least privilege
- IAM.4: No root access keys
- S3.1: Block public access
- S3.4: Encryption at rest
- RDS.3: Database encryption

### High Impact Level
All Moderate controls plus:
- CloudTrail.2: Log file validation
- IAM.5: MFA required
- IAM.6: Hardware MFA for root
- Enhanced monitoring and alerting

## Compliance Reporting

### Evidence Collection
For each remediated finding, collect:
1. **Before state**: Screenshot or API output showing non-compliance
2. **Remediation steps**: Commands executed with timestamps
3. **After state**: Screenshot or API output showing compliance
4. **Security Hub update**: Confirmation of finding resolution

### Audit Trail Format
```markdown
## Finding: [Control ID] - [Title]

**Compliance Framework**: [NIST 800-53 / SOC 2 / etc.]
**Control Mapping**: [Specific control reference]
**Remediation Date**: [ISO 8601 timestamp]
**Remediated By**: [User/Role]

### Evidence
- Before: [Link to evidence file]
- Commands: [Link to command log]
- After: [Link to validation evidence]
- Security Hub: [Finding ARN and status]
```

### Compliance Dashboard Metrics
- Total findings by framework
- Remediation rate by severity
- Mean time to remediation (MTTR)
- Compliance percentage by control family
- Trend analysis over time
