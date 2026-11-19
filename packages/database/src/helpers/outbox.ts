import type { Database } from '../client.js';
import type { Tx } from '../transaction.js';

/** An unpublished outbox row (the payload is the full event envelope). */
export interface OutboxRow {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
}

/** Result of publishing one row: ok, or the error message to record. */
export type PublishOutcome = { id: string; ok: true } | { id: string; ok: false; error: string };

export interface OutboxSource {
  /**
   * Claims up to `limit` unpublished rows (`FOR UPDATE SKIP LOCKED`, so several relay replicas never
   * publish the same row), hands them to `publish`, then records the outcomes — all in one
   * transaction. Returns how many rows were claimed (0 = idle).
   */
  drain(limit: number, publish: (rows: OutboxRow[]) => Promise<PublishOutcome[]>): Promise<number>;
}

/** Rows that failed this many times stay unpublished for an operator (and an alert). */
export const OUTBOX_MAX_ATTEMPTS = 10;

export const createOutboxSource = (db: Database): OutboxSource => ({
  async drain(limit, publish) {
    return db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<OutboxRow[]>`
          SELECT "id", "type", "payload", "attempts" FROM "outbox_events"
          WHERE "publishedAt" IS NULL AND "attempts" < ${OUTBOX_MAX_ATTEMPTS}
          ORDER BY "createdAt", "id"
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED`;
        if (rows.length === 0) return 0;
        const outcomes = await publish(rows);
        const done = outcomes.filter((o) => o.ok).map((o) => o.id);
        if (done.length > 0) {
          await tx.outboxEvent.updateMany({
            where: { id: { in: done } },
            data: { publishedAt: new Date() },
          });
        }
        for (const failed of outcomes) {
          if (failed.ok) continue;
          await tx.outboxEvent.update({
            where: { id: failed.id },
            data: { attempts: { increment: 1 }, lastError: failed.error.slice(0, 1000) },
          });
        }
        return rows.length;
      },
      { maxWait: 5_000, timeout: 30_000 },
    );
  },
});

/**
 * Consumer inbox: records `(eventId, consumer)` inside the handler's transaction. Returns false when
 * the event was already processed (duplicate delivery) — the caller then skips the handler.
 */
export const claimInboxEvent = async (
  tx: Tx,
  eventId: string,
  consumer: string,
): Promise<boolean> => {
  const inserted = await tx.$executeRaw`
    INSERT INTO "processed_events" ("eventId", "consumer")
    VALUES (${eventId}::uuid, ${consumer})
    ON CONFLICT DO NOTHING`;
  return inserted === 1;
};

/** Transactional outbox write: the event row commits (or rolls back) with the business change. */
export const writeOutboxEvent = async (
  tx: Tx,
  envelope: { id: string; type: string },
): Promise<void> => {
  await tx.outboxEvent.create({
    // tsc needs the cast (envelope interfaces lack an index signature); type-aware ESLint calls it
    // unnecessary — same mismatch as farm-service's OutboxWriter.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    data: { id: envelope.id, type: envelope.type, payload: envelope as object },
  });
};
