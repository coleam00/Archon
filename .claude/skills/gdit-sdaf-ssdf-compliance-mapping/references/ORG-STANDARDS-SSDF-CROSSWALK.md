# Organization Standards → NIST 800-218 (SSDF) Crosswalk

**Purpose**: Pre-digested mapping of organization policy, standards, and handbook requirements to NIST SP 800-218 sub-practices. Use this file during `create-family-mapping` to cite organizational compliance evidence alongside pipeline profile capabilities.

**Generated**: 2026-03-31
**Source Documents**:
| ID | Document | Version/Date |
|----|----------|-------------|
| ITPOL50 | IT-POL-50 Cyber Security Policy | Current |
| ITMAN50A | IT-MAN-50-A GDIT IT Cyber Security Procedure Manual | 10/28/2025 |
| ITHB501C | IT-HB-50-1C GDIT Cyber Security Handbook | 03/06/2026 |
| ITHB5001A | IT-HB-50-1A GDIT Employee/Non-Employee Cyber Security Handbook | 03/12/2026 |
| ITSTD5011 | IT-STD-50-11 IT Secure Development Standard | 03/11/2026 |

**How to Use**: When generating a per-family compliance mapping, read this file to identify which org standards support each NIST 800-218 sub-practice. Add an "Organization Standards Alignment" section under each sub-practice citing the relevant controls. This provides auditors with dual evidence: pipeline implementation (from profile) AND organizational policy backing.

---

## PO — Prepare the Organization

### PO.1.1: Identify and document security requirements for development infrastructure and processes

**Org Standards Alignment**:
- ITSTD5011 §4.1.1: All solutions must be provisioned per security controls in ITMAN50A, aligned with ITHB501C. New software acquisitions follow SDLC lifecycle gates including 3PRA, IRB, ARB, DDR, and ORR with Cyber Security Team approval throughout.
- ITHB501C §3.12.1: Security risks must be reviewed and secure coding practices used when developing or modifying systems. Security Assessment Reports are required.
- ITPOL50 §Roles: CISO develops and implements policies ensuring compliance with GD CP 07-102 across all environments.
- ITHB501C §3.4.1: Baseline configurations and inventories maintained throughout SDLC. Deviations tracked and approved.
- ITMAN50A §2 (Scope): Procedures support NIST SP 800-171 Rev 2 controls and ISO 27001:2022.

### PO.1.2: Identify and document security requirements for software being developed

**Org Standards Alignment**:
- ITSTD5011 §4.1.4: All coding conventions must comply with cyber security policies for access, authentication, audit logging, encryption, and data validation.
- ITSTD5011 §4.1.3: Information security integrated into all SDLC phases. Least privilege and separation of duties required. Role-based access controls enforced.
- ITHB501C §3.13.2: Architectural designs and software development techniques must promote effective information security.
- ITHB501C §3.4.2: Security configuration settings established and enforced using CIS hardening or equivalent standards.

### PO.1.3: Communicate requirements to all third parties involved in the SDLC

**Org Standards Alignment**:
- ITSTD5011 §4.1.10: Outsourced development obtained through contractual agreements. Vendors screened per ITHB501C. Vendors must comply with all secure design, development, code management, and testing standards.
- ITHB501C §3.4.1 GD-1: Only authorized computing devices and software products used. All third-party services undergo 3PRA prior to purchase or integration.
- ITMAN50A §17.1: GDIT uses SDLC model with Cyber Security Team collaboration throughout.

### PO.2.1: Create new roles and alter existing responsibilities as needed

**Org Standards Alignment**:
- ITPOL50 §Roles: Defines CISO role, Division CISOs/AODR roles, and additional interested parties with IS-specific requirements.
- ITMAN50A §3.6: Separation of duties between Cyber Security Services oversight and IT GCIO Services. CISO reports to GCIO. Specific roles defined for Cyber Operations, IT Risk Management, Cyber Engineering.
- ITHB501C §3.1.4: Separation of duties required to reduce risk of malevolent activity.

### PO.2.2: Provide role-based training for all personnel involved

**Org Standards Alignment**:
- ITHB501C §3.2.1: Cyber Security Awareness Training completed within 30 days of initial access and annually thereafter.
- ITHB501C §3.2.2: Personnel trained to carry out assigned security duties.
- ITHB501C §3.2.3: Security awareness training on recognizing insider threats.
- ITMAN50A §4: References IT-STD-50-4 Cyber Security Awareness Training Standard.
- ITMAN50A §3.4: Privileged account users complete Privileged Access training within 30 days.
- ITHB5001A §6.1: All users complete Cyber Smart 365 New Hire Program within 30 days. Annual micro modules required.

### PO.2.3: Obtain management commitment to secure development

**Org Standards Alignment**:
- ITPOL50 §Roles: CISO develops and communicates policies. Division CISOs/AODRs manage deviations through formal Variance Process documented in SSP.
- ITHB501C §2.0: OPA and Variance processes require formal risk acceptance by appropriate authority.
- ITMAN50A §18.18: Division Management responsible for compliance and integrity of externally facing systems.

### PO.3.1: Specify which tools or tool types must be included in each toolchain

**Org Standards Alignment**:
- ITSTD5011 §4.1.1: New software acquisitions follow lifecycle gates (IRB, IRSC, ARB, DDR, ORR) with Cyber Security Team as approving member.
- ITHB501C §3.4.1 GD-1: Only authorized software products used. All software not in Approved Software List requires CISO approval.
- ITMAN50A §7.3: All software reviewed and approved by Cyber Operations Team prior to acquisition. Cloud software undergoes 3PRA.

### PO.3.2: Follow change management processes when deploying or updating toolchains

**Org Standards Alignment**:
- ITSTD5011 §4.1.6: All changes deployed per IT-PRC-8-0-A GCIO Services Change Management Process.
- ITMAN50A §7.5-7.7: All configuration changes follow Change Management Process. No changes without CAB approval. Emergency change process defined.
- ITHB501C §3.4.3: Track, review, approve/disapprove, and log changes. ISSOs need CISO/AODR approval for security-relevant changes.
- ITHB501C §3.4.4: Security impact analysis required prior to implementation.

### PO.3.3: Configure tools to generate artifacts for evidence and action

**Org Standards Alignment**:
- ITHB501C §3.3.1: Audit logs retained 365 days. Logs must contain event type, date/time, location, source, outcome, and identity. Console logging required for IaaS/PaaS.
- ITMAN50A §5.1-5.13: Comprehensive audit record procedures including real-time alerts, correlation, and retention requirements.

### PO.4.1: Define criteria for software security checks throughout the SDLC

**Org Standards Alignment**:
- ITSTD5011 §4.1.4: Code tested throughout SDLC. Custom code peer-reviewed and approved prior to production. Penetration testing may be performed.
- ITHB501C §3.12.1: Security controls periodically assessed for effectiveness. Secure coding practices required.
- ITHB501C §3.14 (SI): Vulnerability remediation timelines defined for internet-facing and non-internet-facing systems.

### PO.4.2: Implement processes, mechanisms, and tools to evaluate against criteria

**Org Standards Alignment**:
- ITMAN50A §16.1: Vulnerability scanning performed daily. Authenticated and unauthenticated scans on defined schedule. Qualys agents check in every 4 hours.
- ITHB501C §3.11.2: Authenticated scans conducted at least weekly on internal environments.
- ITMAN50A §16.2-16.3: Vulnerability reporting and tracking from discovery to remediation on weekly basis.

### PO.5.1: Separate and protect each environment

**Org Standards Alignment**:
- ITSTD5011 §4.1.2: Development, test, and UAT environments logically separated and segregated (network, infrastructure, database). Separate logins governed by access controls.
- ITHB501C §3.13.5: Subnetworks for publicly accessible components physically or logically separated from internal networks.
- ITHB501C §3.13.2: Network trust levels defined (Levels 1-5) with specific security requirements per level.
- ITMAN50A §18.3-18.4: DMZ reference architecture with segmented zones and firewall segregation.

### PO.5.2: Secure and harden development endpoints

**Org Standards Alignment**:
- ITHB501C §3.4.2: Security configuration settings enforced using CIS hardening or equivalent.
- ITMAN50A §18.1: All devices centrally managed. End-to-end encryption required. Hardening per CIS standards.
- ITHB5001A §14.1: Mobile device use and handling requirements. GDIT-managed endpoints only.
- ITMAN50A §18.8: Desktop/laptop environment protections including anti-malware, latest signatures, hard drive encryption.

---

## PS — Protect the Software

### PS.1.1: Store all forms of code in repositories with access controls and integrity verification

**Org Standards Alignment**:
- ITSTD5011 §4.1.5: All source code stored in secure repositories. Access controlled on user account basis, restricted by role and responsibilities. Version control required. Annual backup restoration testing.
- ITSTD5011 §4.1.6: Access between dev and prod restricted to authorized personnel. Separation of duties maintained throughout deployment lifecycle.
- ITHB501C §3.1.1: System access limited to authorized users. IAM solution required.
- ITHB501C §3.1.5: Principle of least privilege enforced. Quarterly privileged access reviews.
- ITHB501C §3.4.5: Physical and logical access restrictions for changes documented and enforced.

### PS.2.1: Make software integrity verification information available to consumers

**Org Standards Alignment**:
- ITMAN50A §3.5: Cryptographic requirements including FIPS 140-2 validated HSMs and certificates. Keys at least 2048 bits. All data encrypted in transit.
- ITHB501C §3.13.1 GD-3: All links using untrusted mediums encrypted. TLS 1.2+ required. Self-signed and wildcard certificates prohibited.
- ITHB501C §3.8.6: Cryptographic mechanisms protect confidentiality of sensitive information on digital media during transport.

### PS.3.1: Securely archive necessary files and supporting data for each release

**Org Standards Alignment**:
- ITHB501C §3.8.9: Backup confidentiality protected at storage locations.
- ITHB501C §3.8.9 GD-2: Complete data backups stored offsite/offline or as immutable backups. Separate availability zones for cloud. Public snapshots prohibited.
- ITMAN50A §8: Systems adhere to BC/DR Plan. Backup and recovery on routine schedule.
- ITHB501C §3.3.1: Audit records retained 365 days.

### PS.3.2: Maintain provenance information for all components of each release

**Org Standards Alignment**:
- ITHB501C §3.4.1: Baseline configurations and inventories maintained throughout SDLC including hardware, software, firmware, and documentation.
- ITHB501C §3.4.1 GD-2: CMDB covering IT assets of various types. Records refreshed monthly.
- ITHB501C §3.4.3: All changes tracked, reviewed, approved, and logged.

---

## PW — Produce Well-Secured Software

### PW.1.1: Use risk modeling to assess security risk

**Org Standards Alignment**:
- ITHB501C §3.11.1: Periodic risk assessments of organizational operations and assets. Updated at least annually.
- ITHB501C §3.11.1 GD-1: Risk assessments required for new network connections, new security products, mergers/acquisitions, ASPs, and cloud providers.
- ITMAN50A §16.4: Penetration testing performed at minimum annually.

### PW.1.2: Track and maintain security requirements, risks, and design decisions

**Org Standards Alignment**:
- ITHB501C §3.12.4: System security plans describe boundaries, environments, security implementation, and system relationships. Monthly updates to ISSO, quarterly to CISO.
- ITHB501C §3.12.2: Plans of action to correct deficiencies and reduce vulnerabilities.
- ITHB501C §2.1: OPA process tracks deficiencies with steps, resources, responsibilities, and timelines.

### PW.1.3: Build in support for standardized security features

**Org Standards Alignment**:
- ITHB501C §3.13.1 GD-3: TLS 1.2+ required. Certificate standards defined (no wildcards, no self-signed, key length minimums).
- ITHB501C §3.5.3: MFA required for privileged and non-privileged accounts.
- ITMAN50A §3.5.1: Server certificate requirements including FIPS 140-2 validation.

### PW.2.1: Have qualified persons review the design

**Org Standards Alignment**:
- ITSTD5011 §4.1.1: Lifecycle gates include ARB (Architecture Review Board) and DDR (Detailed Design Review) with Cyber Security Team as approving member.
- ITSTD5011 §4.1.4: Custom code peer-reviewed and approved prior to production deployment.
- ITHB501C §3.4.4: Security impact analysis required prior to implementation. ERB/CAB/CCB process with ISSO participation and CISO/AODR approval.

### PW.4.1: Acquire and maintain well-secured components from third parties

**Org Standards Alignment**:
- ITHB501C §3.4.1 GD-1: All third-party services undergo 3PRA prior to purchase or integration.
- ITMAN50A §7.3: All software reviewed and approved by Cyber Operations Team. Cloud software undergoes 3PRA.
- ITMAN50A §7.4: Only supported software receiving regular security/patch updates. Unsupported software requires CISO-approved variance with compensating controls.
- ITSTD5011 §4.1.10: Outsourced development through contractual agreements with vendor screening.

### PW.4.2: Create and maintain well-secured components in-house

**Org Standards Alignment**:
- ITSTD5011 §4.1.4: Coding conventions comply with cyber security policies. Code tested throughout SDLC. Peer review required before production.
- ITSTD5011 §4.1.5: Source code in secure repositories with version control and access controls.
- ITHB501C §3.12.1: Secure coding practices required when developing or modifying systems.

### PW.4.4: Verify acquired components comply with requirements throughout life cycles

**Org Standards Alignment**:
- ITMAN50A §16.1: Vulnerability scanning daily. Qualys agents on endpoints check in every 4 hours. EPM tool blocks unapproved software.
- ITHB501C §3.11.2: Authenticated scans at least weekly. External attack surface monitoring.
- ITMAN50A §7.4: Unsupported software requires variance with documented business requirement, compensating controls, and retirement plan.

### PW.5.1: Follow all secure coding practices

**Org Standards Alignment**:
- ITSTD5011 §4.1.4: All coding conventions comply with GDIT Cyber Security policies for access, authentication, audit logging, encryption, and data validation. Open-source code permitted but must comply with standards.
- ITSTD5011 §4.1.7: Proper error and exception handling required. No information leakage. Applications fail safely.
- ITSTD5011 §4.1.8: Test data selected and controlled based on data classification.
- ITSTD5011 §4.1.9: Data masking required when outsourced to third parties (especially offshore).
- ITHB501C §3.12.1: Secure coding practices required. Security Assessment Reports produced.
- References GD CSHB Appendix H — Secure Coding Standards.

### PW.6.1: Use compiler/interpreter/build tools with security features

**Org Standards Alignment**:
- ITSTD5011 §4.1.1: Solutions provisioned per security controls. Lifecycle gates ensure security review of tooling.
- ITHB501C §3.4.6: Principle of least functionality — systems configured for only essential capabilities.
- ITHB501C §3.4.7: Nonessential programs, functions, ports, protocols, and services restricted or disabled.

### PW.6.2: Determine and configure tool security features

**Org Standards Alignment**:
- ITHB501C §3.4.2: Security configuration settings established and enforced. CIS hardening or equivalent as minimum baseline.
- ITHB501C §3.4.2 GDIT-1: Company guidance used to configure key technologies.
- ITHB501C §3.4.8: Deny-by-exception or deny-all/permit-by-exception policies for software execution.

### PW.7.1: Determine whether code review and/or analysis should be used

**Org Standards Alignment**:
- ITSTD5011 §4.1.4: Custom code peer-reviewed and approved prior to production. Penetration testing may be performed.
- ITHB501C §3.12.1: Security risks reviewed and secure coding practices used when developing or modifying systems.

### PW.7.2: Perform code review and/or analysis, record and triage issues

**Org Standards Alignment**:
- ITSTD5011 §4.1.4: Code tested throughout SDLC to ensure security requirements met.
- ITSTD5011 §4.1.10: All outsourced code peer-reviewed by GDIT IT Professional before check-in.
- ITMAN50A §16.2: Vulnerability reporting includes summary, name, criticality, affected system, description, remediation, and advisory links.

### PW.8.1: Determine whether executable code testing should be performed

**Org Standards Alignment**:
- ITHB501C §3.6.3: Penetration tests by third-party assessor at least every 2 years. Annual tabletop/red team exercises.
- ITMAN50A §16.4: Penetration testing performed at minimum annually.
- ITHB501C §3.11.2: Vulnerability scanning periodically and when new vulnerabilities identified.

### PW.8.2: Scope, design, perform testing, and document results

**Org Standards Alignment**:
- ITMAN50A §16.1: Defined scanning schedule (Week 1: unauth, Week 2: network, Week 3: auth, Week 4: network). Reports generated and provided to asset owners.
- ITHB501C §3.11.2 GD-1: Privileged access authorization for vulnerability scanning.
- ITHB501C §3.6.3: Pentest scope includes external DMZ and internal phishing. Purple team exercises optional. Findings shared across BUs.

### PW.9.1: Define a secure baseline for default settings

**Org Standards Alignment**:
- ITHB501C §3.4.2: CIS hardening or equivalent as minimum baseline for security configuration.
- ITHB501C §3.4.1: Baseline configurations established and maintained. Deviations tracked.
- ITMAN50A §18.1: Network/system devices hardened per CIS standards or GDIT-developed alternative.

### PW.9.2: Implement default settings and document for administrators

**Org Standards Alignment**:
- ITHB501C §3.4.2 GDIT-1: Company guidance used for key technologies (cloud, firewalls, email, critical infrastructure).
- ITMAN50A §18.12: Accurate and up-to-date documentation of security architecture required.
- ITHB501C §3.4.1: Baseline reviews triggered by new products, new hardening standards, new security requirements, vulnerability scans, and patches.

---

## RV — Respond to Vulnerabilities

### RV.1.1: Gather information from acquirers, users, and public sources on potential vulnerabilities

**Org Standards Alignment**:
- ITMAN50A §16.1: Daily vulnerability scanning. Qualys agents on endpoints. Monthly scan calendar with authenticated and unauthenticated scans.
- ITHB501C §3.11.2: Authenticated scans at least weekly. External attack surface monitoring via GDIT OCISO tools.
- ITMAN50A §16.2: Vulnerability reporting with summary, name, criticality, affected system, description, remediation, and advisory links.

### RV.1.2: Review, analyze, and/or test code to identify or confirm vulnerabilities

**Org Standards Alignment**:
- ITSTD5011 §4.1.4: Code tested throughout SDLC. Peer review required.
- ITHB501C §3.11.2 GD-1: Privileged access authorization for vulnerability scanning.
- ITMAN50A §16.1: Authenticated scans provide detailed vulnerability and compliance data.

### RV.1.3: Have a policy for addressing vulnerability reports from external sources

**Org Standards Alignment**:
- ITHB501C §3.6.1: Operational incident-handling capability including preparation, detection, analysis, containment, recovery.
- ITHB501C §3.6.1 GDIT-1: Documented incident-handling capability integrated with GDIT IR Process. Annual IR testing.
- ITMAN50A §10.1: All incidents escalated through GDIT Incident Response Process per IT-PL-50-A.

### RV.2.1: Analyze each vulnerability for remediation planning

**Org Standards Alignment**:
- ITMAN50A §16.2: Vulnerability reporting includes criticality, affected systems, description, potential remediation, and advisory links.
- ITMAN50A §16.3: All vulnerabilities tracked from discovery to remediation. Weekly reporting to operational teams.
- ITHB501C §3.11.3: Vulnerabilities remediated in accordance with risk assessments.

### RV.2.2: Develop and implement a plan for each vulnerability

**Org Standards Alignment**:
- ITHB501C §3.12.2: Plans of action to correct deficiencies and reduce/eliminate vulnerabilities.
- ITHB501C §2.1: OPA process with detailed steps, resources, responsibilities, and timelines.
- ITHB501C §2.2: POA&M under CMMC framework — gaps resolved within 180 days.
- ITMAN50A §16.1: SCCM Team and Tiger Team handle patch remediation. EPM tool blocks unapproved software.
- ITHB501C §3.14 (Tables 3-4): Defined remediation timelines for internet-facing and non-internet-facing systems by severity.

### RV.3.1: Analyze identified vulnerabilities to determine root causes

**Org Standards Alignment**:
- ITMAN50A §5.5: Audit trail analysis to reconstruct events, assess damage, and identify how/when/why normal operations ceased.
- ITHB501C §3.3.5: Audit record correlation for investigation and response to unauthorized/suspicious activity.
- ITHB501C §3.6.3: Pentest findings shared across BUs to improve overall security posture.

### RV.3.2: Analyze root causes to identify patterns across vulnerabilities

**Org Standards Alignment**:
- ITMAN50A §5.10: Automated mechanisms integrate and correlate audit review, analysis, and reporting.
- ITHB501C §3.3.5: Automated mechanisms for audit review correlation.
- ITMAN50A §16.1: Qualys database and reporting identifies patterns across endpoints.

### RV.3.3: Review root cause findings and use them to improve practices

**Org Standards Alignment**:
- ITHB501C §3.12.1: Periodic security control assessments. Security Assessment Reports produced and distributed.
- ITHB501C §3.12.3: Security controls monitored on ongoing basis for continued effectiveness.
- ITHB501C §2.1: OPA process ensures continuous improvement and compliance.
- ITSTD5011 §1.0: Pre-existing software modified to comply at next reasonable opportunity.

### RV.3.4: Review and update the vulnerability disclosure policy regularly

**Org Standards Alignment**:
- ITHB501C §3.12.2 GDIT-1: Variance process reviewed at least annually. Variances limited to one year, renewable.
- ITPOL50: Policy reviewed and updated per document approval/change history process.
- ITMAN50A §5.8: Audited events list updated annually or sooner if needed.
- ITHB501C §3.6.2: Incidents tracked, documented, and reported to designated officials.

---

## Quick Reference: Document Scope Summary

| Document | Primary SSDF Relevance | Key Sections |
|----------|----------------------|--------------|
| IT-STD-50-11 | PO.1, PO.3, PO.4, PS.1, PW.2, PW.4, PW.5, PW.7, RV.1 | §4.1.1-4.1.10 (Secure dev standards) |
| IT-HB-50-1C | All families — broadest coverage | §3.1-3.14 (Security control baseline) |
| IT-MAN-50-A | PO.2-PO.5, PS.2-PS.3, PW.8-PW.9, RV.1-RV.3 | §3-19 (Procedures by control family) |
| IT-POL-50 | PO.1, PO.2 | §Roles, §Scope (Policy foundation) |
| IT-HB-50-1A | PO.2, PO.5 | §6.1, §8, §14 (User training, passwords, endpoints) |

## Sections NOT Relevant to SSDF

The following sections from org documents are not applicable to SSDF compliance mapping and should be skipped:
- ITMAN50A §12 (Media Protection/Sanitization) — physical media handling, not software development
- ITMAN50A §13 (Physical/Environmental Protection) — facility security
- ITMAN50A §15 (Personnel Security) — HR processes
- ITHB501C §3.8 (Media Protection) — physical media controls (except §3.8.9 backups)
- ITHB501C §3.9 (Personnel Security) — screening/termination processes
- ITHB501C §3.10 (Physical Protection) — facility access
- ITHB5001A §4 (Prohibited Activities) — end-user behavior rules
- ITHB5001A §7 (Phishing) — end-user awareness
- ITHB5001A §11-13 (Email/Storage/Removable Media) — data handling
- ITHB5001A §14-15 (Mobile/Travel) — device management
- ITHB5001A §16-17 (Classified Spill/Unauthorized Disclosure) — incident-specific
