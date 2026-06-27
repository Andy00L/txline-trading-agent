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
  // Phase string. On the /updates replay feed this stays "scheduled" even post-match; the real
  // phase is in the numeric StatusId below, so settlement derives the phase from StatusId.
  GameState: z.string().nullish(),
  // Numeric soccer phase id: 1 NS, 2 H1, 3 HT, 4 H2, 5 F (ended), 10 FET, 13 FPE. The reliable
  // final-whistle signal on the replay feed. sourceRef: M0-recon-findings.md O9, fixture-status probe.
  StatusId: z.number().int().nullish(),
  // A-4: participant 1 is the home side when true.
  Participant1IsHome: z.boolean(),
  // Milliseconds.
  Ts: z.number().int(),
  // Scheduled kickoff in ms, present on every record including pre-match "scheduled" ones
  // (confirmed: 2116/2116 carried it in the scores-taxonomy probe 2026-06-27). The cross-market
  // entry gates on time-to-kickoff, so it is read off the scores channel.
  StartTime: z.number().int().nullish(),
  // Keys the three-stage score proof together with statKey.
  Seq: z.number().int(),
  // Map<ScoreStatKey, int>; (period*1000)+base_key. Empty pre-match; key 1/2 = goals.
  Stats: z.record(z.string(), z.number().int()).nullish(),
});

export type ScoresPayload = z.infer<typeof scoresPayloadSchema>;
