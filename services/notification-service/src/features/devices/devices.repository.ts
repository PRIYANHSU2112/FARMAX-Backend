import { withPrismaErrors } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { NotificationApp } from '../../domain.js';
import { type DevicePlatform, type DeviceView, MAX_DEVICES_PER_USER } from './devices.types.js';

/** Only place that touches `notification_device_tokens`. */
export class DevicesRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /**
   * Upsert by token (a token re-registered by another user MOVES to that user: a shared or resold
   * phone must never receive the previous owner's notifications), then revoke the user's least
   * recently seen tokens beyond the cap. One transaction, two statements.
   */
  async register(row: {
    id: string;
    userId: string;
    app: NotificationApp;
    platform: DevicePlatform;
    token: string;
    deviceId: string | null;
  }): Promise<DeviceView> {
    return withPrismaErrors(() =>
      this.db.$transaction(async (tx) => {
        const [device] = await tx.$queryRaw<DeviceView[]>`
          INSERT INTO "notification_device_tokens"
            ("id", "userId", "app", "platform", "token", "deviceId", "lastSeenAt", "createdAt")
          VALUES (${row.id}::uuid, ${row.userId}::uuid, ${row.app}::"NotificationApp",
            ${row.platform}::"NotificationDevicePlatform", ${row.token}, ${row.deviceId}, now(), now())
          ON CONFLICT ("token") DO UPDATE SET
            "userId" = EXCLUDED."userId", "app" = EXCLUDED."app", "platform" = EXCLUDED."platform",
            "deviceId" = EXCLUDED."deviceId", "lastSeenAt" = now(), "revokedAt" = NULL
          RETURNING "id", "app", "platform", "deviceId", "lastSeenAt", "createdAt"`;
        await tx.$executeRaw`
          UPDATE "notification_device_tokens" SET "revokedAt" = now()
          WHERE "id" IN (
            SELECT "id" FROM "notification_device_tokens"
            WHERE "userId" = ${row.userId}::uuid AND "revokedAt" IS NULL
            ORDER BY "lastSeenAt" DESC, "id" DESC
            OFFSET ${MAX_DEVICES_PER_USER}
          )`;
        if (device === undefined) throw new Error('device upsert returned no row');
        return device;
      }),
    );
  }

  /** Own token: revoke (idempotent). False when the id is not the user's. */
  async revoke(userId: string, id: string): Promise<boolean> {
    const { count } = await withPrismaErrors(() =>
      this.db.deviceToken.updateMany({
        where: { id, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
    if (count > 0) return true;
    return (await this.db.deviceToken.count({ where: { id, userId } })) > 0;
  }

  /** Active tokens of one user in one app (partial index on active tokens). */
  async activeTokens(
    userId: string,
    app: NotificationApp,
  ): Promise<{ id: string; token: string }[]> {
    return withPrismaErrors(() =>
      this.db.deviceToken.findMany({
        where: { userId, app, revokedAt: null },
        select: { id: true, token: true },
        orderBy: { lastSeenAt: 'desc' },
        take: MAX_DEVICES_PER_USER,
      }),
    );
  }

  /** Tokens the push provider reported dead. */
  async revokeMany(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await withPrismaErrors(() =>
      this.db.deviceToken.updateMany({
        where: { id: { in: [...ids] }, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
  }

  async listActive(userId: string): Promise<DeviceView[]> {
    return withPrismaErrors(() =>
      this.db.deviceToken.findMany({
        where: { userId, revokedAt: null },
        select: {
          id: true,
          app: true,
          platform: true,
          deviceId: true,
          lastSeenAt: true,
          createdAt: true,
        },
        orderBy: { lastSeenAt: 'desc' },
      }),
    );
  }
}
