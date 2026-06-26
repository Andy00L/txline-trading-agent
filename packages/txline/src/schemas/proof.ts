import { z } from 'zod';

/**
 * Three-stage score Merkle proof, returned by GET /api/scores/stat-validation.
 * sourceRef: OpenAPI ScoresStatValidation and its components (v1.5.2), and the
 * repo example backup/examples/data_validation/validate_scores_onchain.ts.
 * hash and root fields are hex strings on the wire (OpenAPI format: binary); the
 * on-chain client converts them to [u8;32]. ProofNode arrays run leaf to root.
 */
export const proofNodeSchema = z.object({
  hash: z.string(),
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
  // Remapped to events_sub_tree_root on chain.
  eventStatsSubTreeRoot: z.string(),
});
export type ScoresBatchSummary = z.infer<typeof scoresBatchSummarySchema>;

// List_ProofNode is oneOf(Nil, ProofNode[]): a proof can be null (an empty branch).
const proofListSchema = z.array(proofNodeSchema).nullable();

export const scoresStatValidationSchema = z.object({
  ts: z.number().int(),
  statToProve: scoreStatSchema,
  eventStatRoot: z.string(),
  summary: scoresBatchSummarySchema,
  statProof: proofListSchema,
  subTreeProof: proofListSchema,
  mainTreeProof: proofListSchema,
  // Present only when statKey2 was requested (two-stat predicates, the 1X2 case).
  statToProve2: scoreStatSchema.optional(),
  statProof2: proofListSchema.optional(),
});
export type ScoresStatValidation = z.infer<typeof scoresStatValidationSchema>;
