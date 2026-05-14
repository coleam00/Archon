# NIST SP 800-218 Practice Definitions (SSDF v1.1)

Paraphrased from NIST SP 800-218 v1.1 (February 2022). Use as reference when creating compliance mapping documents.

## PO — Prepare the Organization

### PO.1: Define Security Requirements for Software Development
Ensure security requirements are specified, communicated, and verifiable for all development activities.
- PO.1.1: Identify and document security requirements for development infrastructure and processes
- PO.1.2: Identify and document security requirements for software being developed or maintained
- PO.1.3: Communicate requirements to all third parties involved in the SDLC

### PO.2: Implement Roles and Responsibilities
Ensure people, processes, and technology are prepared for secure software development.
- PO.2.1: Create new roles and alter existing responsibilities as needed
- PO.2.2: Provide role-based training for all personnel involved
- PO.2.3: Obtain upper management or authorizing official commitment to secure development, and convey that commitment to all with development-related roles and responsibilities

### PO.3: Implement Supporting Toolchains
Use automation to reduce human effort and improve accuracy, reproducibility, usability, and comprehensiveness of security practices.
- PO.3.1: Specify which tools or tool types must be included in each toolchain
- PO.3.2: Follow change management processes when deploying or updating toolchains
- PO.3.3: Configure tools to generate artifacts for evidence and action

### PO.4: Define and Use Criteria for Software Security Checks
Help ensure that software meets security requirements and is free of vulnerabilities before release.
- PO.4.1: Define criteria for software security checks throughout the SDLC
- PO.4.2: Implement processes, mechanisms, and tools to evaluate against criteria

### PO.5: Implement and Maintain Secure Environments
Ensure all environments for software development are secured to protect confidentiality, integrity, and availability.
- PO.5.1: Separate and protect each environment
- PO.5.2: Secure and harden development endpoints

## PS — Protect the Software

### PS.1: Protect All Forms of Code from Unauthorized Access and Tampering
Help prevent unauthorized changes to code (both intentional and unintentional) which could circumvent or negate security.
- PS.1.1: Store all forms of code in repositories with access controls and integrity verification

### PS.2: Provide a Mechanism for Verifying Software Release Integrity
Help software consumers ensure they received legitimate, unaltered software.
- PS.2.1: Make software integrity verification information available to consumers

### PS.3: Archive and Protect Each Software Release
Preserve software releases to enable future analysis, auditing, and incident investigation.
- PS.3.1: Securely archive necessary files and supporting data for each release
- PS.3.2: Maintain provenance information for all components of each release

## PW — Produce Well-Secured Software

### PW.1: Design Software to Meet Security Requirements and Mitigate Security Risks
Identify and evaluate security requirements; determine risks and how design should mitigate them.
- PW.1.1: Use risk modeling (threat modeling, attack modeling, attack surface mapping) to assess security risk
- PW.1.2: Track and maintain security requirements, risks, and design decisions
- PW.1.3: Build in support for standardized security features instead of proprietary implementations

### PW.2: Review the Software Design
Help ensure software will meet security requirements and satisfactorily address identified risks.
- PW.2.1: Have qualified persons not involved in design and/or automated processes review the design

### PW.4: Reuse Existing, Well-Secured Software When Feasible
Lower costs and reduce likelihood of introducing vulnerabilities by reusing vetted components.
- PW.4.1: Acquire and maintain well-secured components from third-party developers
- PW.4.2: Create and maintain well-secured components in-house following SDLC processes
- PW.4.4: Verify acquired components comply with requirements throughout their life cycles

### PW.5: Create Source Code by Adhering to Secure Coding Practices
Decrease vulnerabilities and reduce costs by minimizing vulnerabilities introduced during source code creation.
- PW.5.1: Follow all secure coding practices appropriate to the development languages and environment

### PW.6: Configure the Compilation, Interpreter, and Build Processes
Decrease vulnerabilities by eliminating them before testing occurs.
- PW.6.1: Use compiler, interpreter, and build tools that offer features to improve executable security
- PW.6.2: Determine which tool features should be used, configure them, and implement approved configurations

### PW.7: Review and/or Analyze Human-Readable Code
Help identify vulnerabilities so they can be corrected before release.
- PW.7.1: Determine whether code review and/or code analysis should be used
- PW.7.2: Perform code review and/or analysis, record and triage all discovered issues

### PW.8: Test Executable Code to Identify Vulnerabilities
Help identify vulnerabilities not found by static analysis through dynamic testing.
- PW.8.1: Determine whether executable code testing should be performed and which types
- PW.8.2: Scope the testing, design the tests, perform the testing, and document results

### PW.9: Configure Software to Have Secure Settings by Default
Help improve security at installation time to reduce likelihood of deployment with weak settings.
- PW.9.1: Define a secure baseline so default settings do not weaken platform security
- PW.9.2: Implement the default settings and document each setting for administrators

## RV — Respond to Vulnerabilities

### RV.1: Identify and Confirm Vulnerabilities on an Ongoing Basis
Help ensure vulnerabilities are identified more quickly so they can be remediated more quickly.
- RV.1.1: Gather information from software acquirers, users, and public sources on potential vulnerabilities
- RV.1.2: Review, analyze, and/or test code to identify or confirm vulnerabilities
- RV.1.3: Have a policy for addressing vulnerability reports from external sources

### RV.2: Assess, Prioritize, and Remediate Vulnerabilities
Help ensure vulnerabilities are remediated in accordance with risk to reduce window of opportunity for exploitation.
- RV.2.1: Analyze each vulnerability to gather sufficient information for planning remediation
- RV.2.2: Develop and implement a plan for each vulnerability

### RV.3: Analyze Vulnerabilities to Identify Root Causes
Help reduce future vulnerabilities by learning from past ones.
- RV.3.1: Analyze identified vulnerabilities to determine root causes
- RV.3.2: Analyze root causes to identify patterns across vulnerabilities
- RV.3.3: Review the root cause analysis findings and use them to improve practices
- RV.3.4: Review and update the vulnerability disclosure policy regularly
