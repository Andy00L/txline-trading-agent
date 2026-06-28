import { z } from 'zod';

/**
 * Three-stage score Merkle proof, returned by GET /api/scores/stat-validation.
 * sourceRef: OpenAPI ScoresStatValidation and its components (v1.5.2), and the
 * repo example backup/examples/data_validation/validate_scores_onchain.ts.
 * Confirmed against a live devnet response 2026-06-26: hash and root fields are
 * 32-byte arrays on the wire (number[32], not the hex strings the OpenAPI "binary"
 * format suggested); the on-chain client maps them straight to [u8;32]. ProofNode
 * arrays run leaf to root and may be empty.
 */
const byte32Schema = z.array(z.number().int().min(0).max(255)).length(32);

export const proofNodeSchema = z.object({
  hash: byte32Schema,
  isRightSibling: z.boolean(),
});
export type ProofNode = z.infer<typeof proofNodeSchema>;

export const scoreStatSchema = z.object({
  // off-chain i32, widened to u32 on chain. base 1 = participant 1 goals, 2 = participant 2 goals.
  key: z.number().int(),
  value: z.number().int(),
  // 0 = full game; (period*1000)+base_key encodes period-specific stats.
  period: z.number().int(),
});
export type ScoreStat = z.infer<typeof scoreStatSchema>;

export type Byte32 = z.infer<typeof byte32Schema>;

export const scoresUpdateStatsSchema = z.object({
  updateCount: z.number().int(),
  // Milliseconds; minTimestamp drives the daily scores PDA epoch day.
  minTimestamp: z.number().int(),
  maxTimestamp: z.number().int(),
});
export type ScoresUpdateStats = z.infer<typeof scoresUpdateStatsSchema>;

export const scoresBatchSummarySchema = z.object({
  // off-chain i32, widened to i64 on chain.
  fixtureId: z.number().int(),
  updateStats: scoresUpdateStatsSchema,
  // 32-byte array; remapped to events_sub_tree_root on chain.
  eventStatsSubTreeRoot: byte32Schema,
});
export type ScoresBatchSummary = z.infer<typeof scoresBatchSummarySchema>;

// List_ProofNode is oneOf(Nil, ProofNode[]): a proof can be null (an empty branch).
const proofListSchema = z.array(proofNodeSchema).nullable();

export const scoresStatValidationSchema = z.object({
  ts: z.number().int(),
  statToProve: scoreStatSchema,
  eventStatRoot: byte32Schema,
  summary: scoresBatchSummarySchema,
  statProof: proofListSchema,
  subTreeProof: proofListSchema,
  mainTreeProof: proofListSchema,
  // Present only when statKey2 was requested (two-stat predicates, the 1X2 case).
  statToProve2: scoreStatSchema.optional(),
  statProof2: proofListSchema.optional(),
});
export type ScoresStatValidation = z.infer<typeof scoresStatValidationSchema>;

/**
 * Odds snapshot inside the GET /api/odds/validation response. Like the odds feed it uses
 * PascalCase field names. Only the seven fields the OpenAPI marks required are required; the
 * optional strings and the parallel PriceNames/Prices arrays are nullish (defaulted to empty when
 * the on-chain proof is built). sourceRef: ~/.txline-recon/odds-merkle-proof.md (OddsValidation).
 */
export const oddsSnapshotSchema = z.object({
  FixtureId: z.number().int(),
  MessageId: z.string(),
  Ts: z.number().int(),
  Bookmaker: z.string(),
  BookmakerId: z.number().int(),
  SuperOddsType: z.string(),
  GameState: z.string().nullish(),
  InRunning: z.boolean(),
  MarketParameters: z.string().nullish(),
  MarketPeriod: z.string().nullish(),
  PriceNames: z.array(z.string()).nullish(),
  Prices: z.array(z.number().int()).nullish(),
});
export type OddsSnapshot = z.infer<typeof oddsSnapshotSchema>;

export const oddsUpdateStatsSchema = z.object({
  updateCount: z.number().int(),
  minTimestamp: z.number().int(),
  maxTimestamp: z.number().int(),
});

export const oddsBatchSummarySchema = z.object({
  fixtureId: z.number().int(),
  updateStats: oddsUpdateStatsSchema,
  oddsSubTreeRoot: byte32Schema,
});
export type OddsBatchSummary = z.infer<typeof oddsBatchSummarySchema>;

export const oddsValidationSchema = z.object({
  odds: oddsSnapshotSchema,
  summary: oddsBatchSummarySchema,
  subTreeProof: proofListSchema,
  mainTreeProof: proofListSchema,
});
export type OddsValidation = z.infer<typeof oddsValidationSchema>;
