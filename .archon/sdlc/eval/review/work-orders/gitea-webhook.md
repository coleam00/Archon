# Gitea webhook verifies its signature over decoded text, not the received bytes

## Problem

The Gitea webhook route reads the request body as text with `c.req.text()` (`packages/server/src/index.ts:811-815`) and passes that string to the adapter. The adapter computes the HMAC over the string, not the bytes received (`packages/adapters/src/community/forge/gitea/adapter.ts:276-279`). `Request.text()` decodes UTF-8 and drops a leading BOM. A read-only Bun probe re-encoded wire bytes `[239,187,191,123,125]` as `[123,125]`. So the bytes Gitea signed can differ from the text Archon verifies.

Found by a dogfood run on the change that moved both webhook routes to bounded body reads. It predates that change.

## Why

Signature checks must run over the exact bytes received. Verifying decoded text can make valid deliveries fail. Depending on how decoding normalizes input, it can also make different wire bodies verify the same.

## Why now

A recent change just moved both webhook routes to bounded body reads, so the read path is fresh in mind and easy to change.

## Desired outcome

The Gitea route verifies the HMAC over the raw request bytes, and decodes to text or JSON only after verification passes.

## Invariants

- The body-size limit from the bounded-read change still applies before any read.
- The GitHub route's behavior is unchanged, or fixed the same way if it has the same flaw.
- No secret or body content is logged.

## Acceptance

- A test sends a correctly signed body that starts with a UTF-8 BOM. It is accepted, and it fails on dev.
- A test with a tampered body is still rejected.
