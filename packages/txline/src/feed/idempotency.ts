/**
 * Deduplicates feed events so reconnect-and-backfill never double-emits a record.
 * Odds are keyed by MessageId; scores by (fixtureId, seq). In-memory and
 * deterministic; one tracker per feed run.
 */
export class IdempotencyTracker {
  private readonly seenOdds = new Set<string>();
  private readonly seenScores = new Set<string>();

  /** Returns true the first time a MessageId is seen, false thereafter. */
  acceptOdds(messageId: string): boolean {
    if (this.seenOdds.has(messageId)) {
      return false;
    }
    this.seenOdds.add(messageId);
    return true;
  }

  /** Returns true the first time a (fixtureId, seq) is seen, false thereafter. */
  acceptScore(fixtureId: number, seq: number): boolean {
    const key = `${fixtureId}:${seq}`;
    if (this.seenScores.has(key)) {
      return false;
    }
    this.seenScores.add(key);
    return true;
  }
}
