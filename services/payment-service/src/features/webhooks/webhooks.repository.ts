import { isUniqueViolation, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

export interface WebhookRow {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
}

const MAX_ATTEMPTS = 10;

/** Only place that touches `payment_webhook_events`. */
export class WebhooksRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** Stores a signed delivery once; false when this provider event id was already stored. */
  async insert(data: {
    provider: string;
    eventId: string;
    type: string;
    payloadSha256: string;
    payload: unknown;
  }): Promise<boolean> {
    try {
      await this.db.paymentWebhookEvent.create({
        data: { ...data, payload: data.payload as Prisma.InputJsonValue },
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  pending(limit: number): Promise<WebhookRow[]> {
    return withPrismaErrors(() =>
      this.db.paymentWebhookEvent.findMany({
        where: { processedAt: null, attempts: { lt: MAX_ATTEMPTS } },
        orderBy: { receivedAt: 'asc' },
        take: limit,
        select: { id: true, type: true, payload: true, attempts: true },
      }),
    );
  }

  async done(id: string, note: string | null): Promise<void> {
    await this.db.paymentWebhookEvent.updateMany({
      where: { id, processedAt: null },
      data: { processedAt: new Date(), error: note },
    });
  }

  async failed(id: string, error: string): Promise<void> {
    await this.db.paymentWebhookEvent.update({
      where: { id },
      data: { attempts: { increment: 1 }, error: error.slice(0, 500) },
    });
  }

  forPaymentOrder(providerOrderId: string, limit = 50) {
    return withPrismaErrors(
      () =>
        this.db.$queryRaw<
          {
            id: string;
            type: string;
            receivedAt: Date;
            processedAt: Date | null;
            error: string | null;
          }[]
        >`
        SELECT "id", "type", "receivedAt", "processedAt", "error" FROM "payment_webhook_events"
        WHERE "payload" -> 'payload' -> 'payment' -> 'entity' ->> 'order_id' = ${providerOrderId}
        ORDER BY "receivedAt" LIMIT ${limit}`,
    );
  }
}
