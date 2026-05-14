# Toolchain Change Policy — [Project Name]

**NIST 800-218**: PO.3.1 (Toolchain Specification), PO.3.2 (Toolchain Security)
**Created**: [DATE]
**Last Updated**: [DATE]

---

## Change Categories

| Category | Example | Risk | Approver | Testing Required |
|----------|---------|------|----------|-----------------|
| LOW | Scanner version update (patch) | Minimal | <!-- TODO --> | Verify output format unchanged |
| MEDIUM | New scanner addition | Moderate | <!-- TODO --> | Full pipeline dry run |
| HIGH | Scanner removal, stage change | Significant | <!-- TODO --> | Full dry run + regression |

## Change Process

1. Propose change with justification and risk assessment
2. Obtain approval per category table
3. Implement in non-production branch
4. Run full pipeline dry run
5. Peer review
6. Merge and monitor

## Rollback Procedure

| Category | Rollback Method | SLA |
|----------|----------------|-----|
| <!-- TODO: Define per-category rollback --> | | |

## Tool Integrity Verification

| Tool | Integrity Method | Verification Command |
|------|-----------------|---------------------|
| <!-- TODO: Define per-tool integrity checks --> | | |

## Quarterly Integrity Audit

<!-- TODO: Define audit process for tool versions and integrity -->
