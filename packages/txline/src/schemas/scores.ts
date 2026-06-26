import { z } from 'zod';

/**
 * Scores payload from the scores channel (SSE stream and REST snapshots).
 * sourceRef: OpenAPI Scores schema (scores-stream, v1.5.2).
 * The scores channel uses camelCase field names. The nested score and stats shapes
 * are modelled loosely and confirmed against a live capture; the authoritative final
 * score for settlement comes from the on-chain stat proof, not from this payload.
 */
export const scoresPayloadSchema = z.object({
  fixtureId: z.number().int(),
  // Phase code, for example NS, H1, HT, H2, F (ended). sourceRef: soccer-feed game phase table.
  gameState: z.string(),
  startTime: z.number().int(),
  isTeam: z.boolean(),
  fixtureGroupId: z.number().int(),
  // Numeric competition id; the World Cup value is read from a live payload (O3).
  competitionId: z.number().int(),
  countryId: z.number().int(),
  sportId: z.number().int(),
  // A-4: participant 1 is the home side when true.
  participant1IsHome: z.boolean(),
  participant2Id: z.number().int(),
  participant1Id: z.number().int(),
  action: z.string(),
  id: z.number().int(),
  ts: z.number().int(),
  connectionId: z.number().int(),
  // Keys the three-stage score proof together with statKey.
  seq: z.number().int(),
  // SoccerFixtureStatus enum tag; exact serialized values confirmed at capture.
  statusSoccerId: z.unknown().optional(),
  // SoccerFixtureScore; exact shape confirmed at capture.
  scoreSoccer: z.unknown().optional(),
  // Map<ScoreStatKey, int>; key encoding is (period*1000)+base_key. sourceRef: soccer-feed.
  stats: z.record(z.string(), z.number().int()).optional(),
  possession: z.number().int().optional(),
});

export type ScoresPayload = z.infer<typeof scoresPayloadSchema>;
