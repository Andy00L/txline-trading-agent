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
  // Nullish, not optional: live pre-match records send GameState: null (confirmed at
  // capture 2026-06-26), which .optional() would reject and fail the whole interval.
  GameState: z.string().nullish(),
  MarketParameters: z.string().nullish(),
  MarketPeriod: z.string().nullish(),
  // Outcome labels, parallel to Prices and Pct. 1X2 labels are part1/draw/part2 (O2).
  PriceNames: z.array(z.string()).nullish(),
  // Decimal odds multiplied by 1000 (O1). sourceRef: docs/research/M0-recon-findings.md.
  Prices: z.array(z.number().int()).nullish(),
  // Implied probability as a percentage with three decimals, or "NA" for quarter handicaps.
  Pct: z.array(z.string().regex(/^(NA|\d+\.\d{3})$/)).nullish(),
});

export type OddsPayload = z.infer<typeof oddsPayloadSchema>;
