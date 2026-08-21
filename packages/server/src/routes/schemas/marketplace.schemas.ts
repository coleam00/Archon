/**
 * Zod schemas for the Marketplace Submission endpoint
 * (`POST /api/marketplace/submit`). Attestation booleans are `z.literal(true)`
 * so the server gate is schema-enforced — the checklist can never be bypassed
 * by omitting or falsifying a field.
 */
import { z } from '@hono/zod-openapi';

export const submitMarketplaceAttestationSchema = z
  .object({
    noExfiltration: z.literal(true),
    noDestructiveOps: z.literal(true),
    rightToShare: z.literal(true),
    shaReviewed: z.literal(true),
  })
  .openapi('SubmitMarketplaceAttestation');

export const submitMarketplaceBodySchema = z
  .object({
    workflowName: z.string().min(1),
    cwd: z.string().min(1),
    attestation: submitMarketplaceAttestationSchema,
  })
  .openapi('SubmitMarketplaceBody');

export const marketplaceSubmitResponseSchema = z
  .object({
    prUrl: z.string(),
    slug: z.string(),
    sha: z.string(),
    bundleCommitSha: z.string(),
    action: z.enum(['append', 'update']),
  })
  .openapi('MarketplaceSubmitResponse');
