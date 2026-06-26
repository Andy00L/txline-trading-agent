import { z } from 'zod';

/**
 * Fixture record from the fixtures channel (snapshots and daily updates).
 * sourceRef: docs/research/txline-api.md Fixture object and the IDL Fixture type.
 * The fixtures channel uses PascalCase. The exact field set and the numeric World
 * Cup CompetitionId are confirmed against a live fixtures snapshot at capture (O3).
 */
export const fixtureSchema = z.object({
  FixtureId: z.number().int(),
  Ts: z.number().int(),
  StartTime: z.number().int(),
  Competition: z.string(),
  CompetitionId: z.number().int(),
  FixtureGroupId: z.number().int(),
  Participant1Id: z.number().int(),
  Participant1: z.string(),
  Participant2Id: z.number().int(),
  Participant2: z.string(),
  // A-4: participant 1 is the home side when true.
  Participant1IsHome: z.boolean(),
});

export type Fixture = z.infer<typeof fixtureSchema>;
