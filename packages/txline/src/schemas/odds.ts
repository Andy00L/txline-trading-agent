import { z } from 'zod';

/**
 * Odds payload from the odds channel (SSE stream and REST snapshots).
 * sourceRef: OpenAPI OddsPayload (txline-docs.txodds.com/api-reference/openapi.json, v1.5.2).
 * The odds channel uses PascalCase field names (the scores channel uses camelCase).
 * Schemas are non-strict so unknown future fields are ignored rather than rejected.
 */
export const oddsPayloadSchema = z.object({
  // i64 on the wire; World Cup fixture ids are about 1.7e7, well inside 2^53.
  FixtureId: z.number().int(),
  // Keys the odds Merkle proof (GET /api/odds/validation?messageId=).
  MessageId: z.string(),
  // Milliseconds.
  Ts: z.number().int(),
  Bookmaker: z.string(),
  BookmakerId: z.number().int(),
  // For the free World Cup tier this is the StablePrice de-margined consensus.
  SuperOddsType: z.string(),
  InRunning: z.boolean(),
  GameState: z.string().optional(),
  MarketParameters: z.string().optional(),
  MarketPeriod: z.string().optional(),
  // Outcome labels, parallel to Prices and Pct. Exact 1X2 labels confirmed at capture (O2).
  PriceNames: z.array(z.string()).optional(),
  // Decimal odds multiplied by 1000 (O1). sourceRef: docs/research/M0-recon-findings.md.
  Prices: z.array(z.number().int()).optional(),
  // Implied probability as a percentage with three decimals, or "NA" for quarter handicaps.
  Pct: z.array(z.string().regex(/^(NA|\d+\.\d{3})$/)).optional(),
});

export type OddsPayload = z.infer<typeof oddsPayloadSchema>;
