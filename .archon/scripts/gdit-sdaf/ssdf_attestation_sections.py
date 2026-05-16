"""CISA Secure Software Development Attestation Form — shared section definitions.

Single source of truth for attestation section → NIST 800-218 practice mappings.
Used by both ssdf-auditor and ssdf-development skills.

Based on CISA Secure Software Development Attestation Form (OMB M-22-18, M-23-16).
"""

ATTESTATION_SECTIONS = [
    {
        "id": 1,
        "title": "Secure Development Environment",
        "practices": ["PO.5.1", "PS.1.1", "PS.2.1"],
        "artifacts": [],
        "mapping_doc": "PS-PROTECT-SOFTWARE.md",
    },
    {
        "id": 2,
        "title": "Source Code Supply Chain",
        "practices": ["PS.3.1", "PS.3.2"],
        "artifacts": ["docs/compliance-by-family/PS/SBOM-*.json"],
        "mapping_doc": "PS-PROTECT-SOFTWARE.md",
    },
    {
        "id": 3,
        "title": "Automated Security Testing",
        "practices": ["PW.7.1", "PW.7.2"],
        "artifacts": [],
        "mapping_doc": "PW-PRODUCE-WELL-SECURED-SOFTWARE.md",
    },
    {
        "id": 4,
        "title": "Vulnerability Management",
        "practices": ["RV.1.1", "RV.1.2", "RV.2.1", "RV.2.2"],
        "artifacts": [],
        "mapping_doc": "RV-RESPOND-VULNERABILITIES.md",
    },
    {
        "id": 5,
        "title": "Code Review and Analysis",
        "practices": ["PW.4.1", "PW.4.2"],
        "artifacts": [],
        "mapping_doc": "PW-PRODUCE-WELL-SECURED-SOFTWARE.md",
    },
    {
        "id": 6,
        "title": "Secure Software Design",
        "practices": ["PW.1.1", "PW.1.2"],
        "artifacts": ["docs/compliance-by-family/PW/THREAT-MODEL.md"],
        "mapping_doc": "PW-PRODUCE-WELL-SECURED-SOFTWARE.md",
    },
    {
        "id": 7,
        "title": "Build Integrity",
        "practices": ["PO.3.1", "PO.3.2", "PO.3.3"],
        "artifacts": [],
        "mapping_doc": None,
    },
    {
        "id": 8,
        "title": "Testing",
        "practices": ["PW.8.1", "PW.8.2"],
        "artifacts": [],
        "mapping_doc": None,
    },
]

# T2 Organization-Deferred sub-practices — excluded from attestation gap calculations
T2_PRACTICES = {"PO.1.3", "PO.2.1", "PO.2.2", "PO.2.3", "PO.5.2", "RV.1.3", "RV.3.4"}
