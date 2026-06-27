# Condensed PRD Generator

> Single-prompt PRD generation for any AI platform. Combines BMAD-METHOD quality rules, project-type guidance, and domain requirements into one actionable reference.

## Instructions

1. Read the user's product brief (or ask them to describe their product)
2. Detect the **project type** and **domain** from the brief using the tables below
3. Apply the quality rules and generate a complete PRD
4. The PRD should be information-dense, measurable, and traceable

---

## PRD Structure (9 Required Sections)

### 1. Executive Summary

Vision, differentiator, target users. One paragraph max.

### 2. Success Criteria

Measurable outcomes using SMART criteria:

- **S**pecific: precisely defined
- **M**easurable: quantifiable with test criteria
- **A**ttainable: realistic within constraints
- **R**elevant: aligns with business objectives
- **T**raceable: links to source requirement

### 3. Product Scope

Define MVP, Growth, and Vision phases. What's in scope for each phase, what's explicitly out of scope.

### 4. User Journeys

Comprehensive coverage of how users interact with the product. Each journey should map to functional requirements.

### 5. Domain Requirements

Industry-specific compliance and regulatory requirements (if applicable). See Domain Guidance below.

### 6. Innovation Analysis

Competitive differentiation and novel approaches (if applicable).

### 7. Project-Type Requirements

Platform-specific and architecture-specific needs. See Project Type Guidance below.

### 8. Functional Requirements (FRs)

Capability contract. Each FR must be:

- A **capability**, not implementation ("Users can reset password via email" not "System sends JWT")
- **Measurable** with test criteria ("loads in under 2 seconds" not "fast")
- **Specific** with concrete quantities ("up to 100 concurrent users" not "multiple users")
- **Traceable** to a user journey or success criterion

**FR Anti-Patterns to Avoid:**

- Subjective adjectives: "easy to use", "intuitive", "user-friendly", "fast", "responsive"
- Implementation leakage: technology names, specific libraries, implementation details
- Vague quantifiers: "multiple", "several", "various"
- Missing test criteria: "The system shall provide notifications" (when? how fast? to whom?)

### 9. Non-Functional Requirements (NFRs)

Quality attributes. Each NFR must follow this template:

> "The system shall [metric] [condition] [measurement method]"

Examples:

- "API response time under 200ms for 95th percentile as measured by APM monitoring"
- "99.9% uptime during business hours as measured by cloud provider SLA"
- "Support 10,000 concurrent users as measured by load testing"

**NFR Anti-Patterns to Avoid:**

- Unmeasurable claims: "The system shall be scalable" → specify scale target
- Missing context: "Response time under 1 second" → specify percentile, load conditions

---

## Quality Rules

### Information Density

Every sentence must carry information weight. Zero fluff.

**Replace:**

- "The system will allow users to..." → "Users can..."
- "It is important to note that..." → State the fact directly
- "In order to..." → "To..."

### Traceability Chain

```
Vision → Success Criteria → User Journeys → Functional Requirements
```

Every FR must trace back to a user need. Every success criterion must connect to the vision.

### Dual Audience

The PRD serves both humans (stakeholders review) and AI agents (downstream consumption for UX design, architecture, epics, and implementation). Use:

- Level 2 headings (`##`) for all main sections
- Consistent structure and patterns
- Precise, testable language

---

## Project Type Guidance

Detect the project type from the brief and apply the relevant guidance.

| Type            | Detection Signals                                 | Key Questions                                                                   | Focus Sections                                                                        | Skip Sections                       |
| --------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------- |
| API/Backend     | API, REST, GraphQL, backend, service, endpoints   | Endpoints needed? Auth method? Rate limits? Versioning?                         | Endpoint specs, auth model, data schemas, error codes, rate limits                    | UX/UI, visual design, user journeys |
| Mobile App      | iOS, Android, app, mobile                         | Native or cross-platform? Offline needed? Push notifications? Store compliance? | Platform reqs, device permissions, offline mode, push strategy, store compliance      | Desktop features, CLI commands      |
| SaaS B2B        | SaaS, B2B, platform, dashboard, teams, enterprise | Multi-tenant? Permission model? Subscription tiers? Integrations?               | Tenant model, RBAC matrix, subscription tiers, integration list, compliance           | CLI interface, mobile-first         |
| Developer Tool  | SDK, library, package, npm, pip, framework        | Language support? Package managers? IDE integration? Documentation?             | Language matrix, installation methods, API surface, code examples, migration guide    | Visual design, store compliance     |
| CLI Tool        | CLI, command, terminal, bash, script              | Interactive or scriptable? Output formats? Config method?                       | Command structure, output formats, config schema, scripting support                   | Visual design, UX principles        |
| Web App         | website, webapp, browser, SPA, PWA                | SPA or MPA? Browser support? SEO needed? Real-time? Accessibility?              | Browser matrix, responsive design, performance targets, SEO, accessibility            | Native features, CLI commands       |
| Desktop App     | desktop, Windows, Mac, Linux, native              | Cross-platform? Auto-update? System integration? Offline?                       | Platform support, system integration, update strategy, offline capabilities           | Web SEO, mobile features            |
| IoT/Embedded    | IoT, embedded, device, sensor, hardware           | Hardware specs? Connectivity? Power constraints? Security? OTA updates?         | Hardware reqs, connectivity protocol, power profile, security model, update mechanism | Visual UI, browser support          |
| Blockchain/Web3 | blockchain, crypto, DeFi, NFT, smart contract     | Chain selection? Wallet integration? Gas optimization? Security audit?          | Chain specs, wallet support, smart contracts, security audit, gas optimization        | Traditional auth, centralized DB    |
| Game            | game, player, gameplay, level, character          | Use the BMAD Game Module agent and workflows instead                            | Game brief, GDD                                                                       | Most sections                       |

---

## Domain Guidance

Detect the domain from the brief and ensure mandatory requirements are included.

| Domain              | Signals                                               | Complexity | Key Concerns                                                                                            |
| ------------------- | ----------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| Healthcare          | medical, clinical, FDA, patient, HIPAA, therapy       | High       | FDA approval, clinical validation, HIPAA compliance, patient safety, MFA, audit logging, PHI encryption |
| Fintech             | payment, banking, trading, KYC, AML, transaction      | High       | PCI-DSS Level 1, AML/KYC compliance, SOX controls, financial audit trails, fraud prevention             |
| GovTech             | government, federal, civic, public sector, citizen    | High       | NIST framework, Section 508 accessibility (WCAG 2.1 AA), FedRAMP, data residency, procurement rules     |
| EdTech              | education, learning, student, teacher, LMS            | Medium     | COPPA/FERPA student privacy, accessibility, content moderation, age verification, curriculum standards  |
| Aerospace           | aircraft, spacecraft, aviation, drone, satellite      | High       | DO-178C compliance, safety certification, simulation accuracy, export controls (ITAR)                   |
| Automotive          | vehicle, autonomous, ADAS, automotive, EV             | High       | ISO 26262 functional safety, V2X communication, real-time requirements, certification                   |
| Scientific          | research, algorithm, simulation, ML, AI, data science | Medium     | Reproducibility, validation methodology, statistical validity, computational resources                  |
| LegalTech           | legal, law, contract, compliance, litigation          | High       | Legal ethics, bar regulations, data retention, attorney-client privilege, court integration             |
| InsureTech          | insurance, claims, underwriting, actuarial, policy    | High       | Insurance regulations by state, actuarial standards, fraud detection, regulatory reporting              |
| Energy              | energy, utility, grid, solar, wind, power             | High       | NERC grid compliance, environmental regulations, safety requirements, SCADA systems                     |
| Process Control     | industrial automation, PLC, SCADA, DCS, OT            | High       | IEC 62443 OT cybersecurity, functional safety, real-time control, legacy integration                    |
| Building Automation | BAS, BMS, HVAC, smart building, life safety           | High       | Life safety codes, building energy standards, multi-trade interoperability, commissioning               |
| General             | (no specific signals)                                 | Low        | Standard security, user experience, performance                                                         |

**Critical:** Missing domain-specific requirements in the PRD means they'll be missed in architecture and implementation. Always check the domain table and include applicable requirements.

---

## Output Format

Generate the PRD as a markdown document with:

- `##` headings for each of the 9 required sections
- Tables where appropriate (user journeys, requirements)
- Specific, measurable language throughout
- No filler words or conversational padding
- Domain requirements section populated based on detected domain
- Project-type specific sections included/skipped per guidance
