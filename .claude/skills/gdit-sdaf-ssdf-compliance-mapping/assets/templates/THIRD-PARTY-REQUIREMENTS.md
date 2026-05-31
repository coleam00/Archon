# Third-Party Security Requirements — [Project Name]

**NIST 800-218**: PO.1.3 (Third-Party Requirements)
**Created**: [DATE]
**Last Updated**: [DATE]

---

## Core Security Requirements for Software Components

| Requirement | Description | Verification Method |
|-------------|-------------|-------------------|
| Vulnerability disclosure | Maintainer has a disclosure policy | Manual review at adoption |
| Patch SLA | Security patches within 90 days of CVE | <!-- TODO --> |
| Provenance data | SBOM or equivalent available | SBOM generation |
| Signed releases | Releases are signed or checksummed | Manual review |
| Active maintenance | At least one release in past 12 months | Dependency age check |

## Blocked Sources

| Condition | Rationale | Enforcement |
|-----------|-----------|-------------|
| No provenance data | Supply chain risk | <!-- TODO --> |
| Abandoned projects (>12 months) | Unpatched vulnerability risk | <!-- TODO --> |
| Blocked licenses | License compliance | <!-- TODO --> |

## Attestation Requirements

<!-- TODO: Define what provenance and integrity data is published per release -->
