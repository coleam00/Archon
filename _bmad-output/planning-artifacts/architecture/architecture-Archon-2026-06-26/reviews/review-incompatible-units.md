# Incompatible Independently Built Units Review

Verdict: PASS after inline fixes.

## Findings

### I1 - Server and Web could diverge on route live updates

Severity: High.
Status: Fixed.

Without a named SSE payload, one unit could emit only generic refetch notifications while another expects route-edge state in the payload.
AD-13 now fixes `workflow_route` as the live contract.

### I2 - Core could persist route audit while workflows expects six-field output only

Severity: Medium.
Status: Fixed.

The audit event needs identifiers and ordering fields that do not belong in the v1 `route_loop.output`.
AD-5 and AD-6 now define the split.

### I3 - Metadata update ownership is clear

Severity: None.
Status: No issue.

The spine assigns route metadata mutation to a strict store method implemented in core.
That prevents `dag-executor.ts` from hand-merging nested JSON and racing with resume or retry updates.
