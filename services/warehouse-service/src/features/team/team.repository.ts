import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { StaffDocType, WorkArea } from './team.types.js';

const PROFILE = {
  warehouseId: true,
  userId: true,
  phone: true,
  workAreas: true,
  jobTitle: true,
  shiftId: true,
  status: true,
} as const satisfies Prisma.WmsStaffProfileSelect;

const DOC = {
  userId: true,
  docType: true,
  mediaKey: true,
  mime: true,
  sizeBytes: true,
  uploadedAt: true,
} as const satisfies Prisma.WmsStaffDocumentSelect;

export type ProfileRow = Prisma.WmsStaffProfileGetPayload<{ select: typeof PROFILE }>;
export type DocRow = Prisma.WmsStaffDocumentGetPayload<{ select: typeof DOC }>;

/** Only place that touches `warehouse_staff_profiles` and `warehouse_staff_documents`. */
export class TeamRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  profiles(warehouseId: string): Promise<ProfileRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsStaffProfile.findMany({ where: { warehouseId }, select: PROFILE, take: 2_000 }),
    );
  }

  profile(warehouseId: string, userId: string): Promise<ProfileRow | null> {
    return withPrismaErrors(() =>
      this.db.wmsStaffProfile.findUnique({
        where: { warehouseId_userId: { warehouseId, userId } },
        select: PROFILE,
      }),
    );
  }

  upsertProfile(
    tx: Tx,
    key: { warehouseId: string; userId: string },
    data: {
      phone?: string | null;
      workAreas?: WorkArea[];
      shiftId?: string | null;
      jobTitle?: string | null;
      status?: 'ACTIVE' | 'INACTIVE';
      byUserId: string;
    },
  ): Promise<ProfileRow> {
    const { byUserId, ...fields } = data;
    return withPrismaErrors(() =>
      tx.wmsStaffProfile.upsert({
        where: { warehouseId_userId: key },
        create: {
          ...key,
          phone: fields.phone ?? null,
          workAreas: fields.workAreas ?? [],
          shiftId: fields.shiftId ?? null,
          jobTitle: fields.jobTitle ?? null,
          status: fields.status ?? 'ACTIVE',
          createdByUserId: byUserId,
          updatedByUserId: byUserId,
        },
        update: { ...fields, updatedByUserId: byUserId },
        select: PROFILE,
      }),
    );
  }

  documents(warehouseId: string, userIds?: readonly string[]): Promise<DocRow[]> {
    return withPrismaErrors(() =>
      this.db.wmsStaffDocument.findMany({
        where: { warehouseId, ...(userIds === undefined ? {} : { userId: { in: [...userIds] } }) },
        select: DOC,
        orderBy: { docType: 'asc' },
      }),
    );
  }

  /** One current file per type: a re-upload replaces it (the old key is returned for cleanup). */
  async putDocument(
    tx: Tx,
    data: {
      warehouseId: string;
      userId: string;
      docType: StaffDocType;
      mediaKey: string;
      mime: string;
      sizeBytes: number;
      uploadedByUserId: string;
    },
  ): Promise<string | null> {
    const { warehouseId, userId, docType } = data;
    const before = await withPrismaErrors(() =>
      tx.wmsStaffDocument.findUnique({
        where: { warehouseId_userId_docType: { warehouseId, userId, docType } },
        select: { mediaKey: true },
      }),
    );
    await withPrismaErrors(() =>
      tx.wmsStaffDocument.upsert({
        where: { warehouseId_userId_docType: { warehouseId, userId, docType } },
        create: data,
        update: {
          mediaKey: data.mediaKey,
          mime: data.mime,
          sizeBytes: data.sizeBytes,
          uploadedByUserId: data.uploadedByUserId,
          uploadedAt: new Date(),
        },
      }),
    );
    return before?.mediaKey ?? null;
  }
}
