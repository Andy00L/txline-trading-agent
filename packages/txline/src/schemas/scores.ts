import { z } from 'zod';

/**
 * Scores payload from the scores channel (SSE stream and REST updates). Confirmed against
 * a live capture 2026-06-26: the scores channel uses PascalCase field names (like the odds
 * channel), not camelCase as the M0 notes assumed. Only the fields settlement needs are
 * declared; z.object strips the rest (StartTime, CompetitionId, Action, Confirmed, ...).
 * sourceRef: docs/research/M0-recon-findings.md (A-3, A-4).
 */
export const scoresPayloadSchema = z.object({
  FixtureId: z.number().int(),
  // Phase string, for example "scheduled", "H1", "F". Nullish on some connection records.
  GameState: z.string().nullish(),
  // A-4: participant 1 is the home side when true.
  Participant1IsHome: z.boolean(),
  // Milliseconds.
  Ts: z.number().int(),
  // Keys the three-stage score proof together with statKey.
  Seq: z.number().int(),
  // Map<ScoreStatKey, int>; (period*1000)+base_key. Empty pre-match; key 1/2 = goals.
  Stats: z.record(z.string(), z.number().int()).nullish(),
});

export type ScoresPayload = z.infer<typeof scoresPayloadSchema>;
