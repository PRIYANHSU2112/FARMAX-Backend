import { type Tx, withPrismaErrors } from '@farmx/database';
import { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { WarehouseScope } from '../../middleware/access.js';

const CASE = {
  checks: { orderBy: { type: 'asc' } },
} as const satisfies Prisma.WmsComplianceCaseInclude;
export type CaseRow = Prisma.WmsComplianceCaseGetPayload<{ include: typeof CASE }>;
export type CheckRow = Prisma.WmsComplianceCheckGetPayload<object>;
export type RuleRow = Prisma.WmsComplianceRuleGetPayload<object>;
export type JsonInput = Prisma.InputJsonValue;

const scoped = (scope: WarehouseScope, warehouseId?: string) =>
  warehouseId !== undefined
    ? { warehouseId }
    : scope === 'ALL'
      ? {}
      : { warehouseId: { in: [...scope] } };

/** Only place that touches the compliance tables (W3.16). */
export class ComplianceRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  rules(tx?: Tx): Promise<RuleRow[]> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsComplianceRule.findMany({ orderBy: { key: 'asc' } }),
    );
  }

  rule(key: string) {
    return withPrismaErrors(() => this.db.wmsComplianceRule.findUnique({ where: { key } }));
  }

  upsertRule(tx: Tx, key: string, data: Omit<Prisma.WmsComplianceRuleUncheckedCreateInput, 'key'>) {
    return tx.wmsComplianceRule.upsert({
      where: { key },
      create: { key, ...data },
      update: { ...data, version: { increment: 1 } },
    });
  }

  byOrder(orderId: string, tx?: Tx): Promise<CaseRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsComplianceCase.findUnique({ where: { orderId }, include: CASE }),
    );
  }

  case(id: string, tx?: Tx): Promise<CaseRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).wmsComplianceCase.findUnique({ where: { id }, include: CASE }),
    );
  }

  async lock(tx: Tx, id: string): Promise<CaseRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "warehouse_compliance_cases" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return this.case(id, tx);
  }

  async create(
    tx: Tx,
    data: Prisma.WmsComplianceCaseUncheckedCreateInput,
    checks: Omit<Prisma.WmsComplianceCheckCreateManyInput, 'caseId'>[],
  ): Promise<CaseRow> {
    const c = await tx.wmsComplianceCase.create({ data, select: { id: true } });
    if (checks.length > 0)
      await tx.wmsComplianceCheck.createMany({ data: checks.map((x) => ({ ...x, caseId: c.id })) });
    const row = await this.case(c.id, tx);
    if (row === null) throw new Error('case vanished');
    return row;
  }

  async update(tx: Tx, id: string, data: Prisma.WmsComplianceCaseUncheckedUpdateInput) {
    await tx.wmsComplianceCase.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
      select: { id: true },
    });
  }

  async updateCheck(tx: Tx, id: string, data: Prisma.WmsComplianceCheckUncheckedUpdateInput) {
    await tx.wmsComplianceCheck.update({ where: { id }, data, select: { id: true } });
  }

  cases(
    scope: WarehouseScope,
    f: { status?: string; q?: string; warehouseId?: string; orderIds?: string[] },
    page: { limit: number; offset: number | null; cursor?: string },
  ) {
    return withPrismaErrors(() =>
      this.db.wmsComplianceCase.findMany({
        where: {
          ...scoped(scope, f.warehouseId),
          ...(f.status === undefined ? {} : { status: f.status as CaseRow['status'] }),
          ...(f.q === undefined
            ? {}
            : {
                OR: [
                  { caseNo: { contains: f.q, mode: 'insensitive' } },
                  { orderId: { in: f.orderIds ?? [] } },
                ],
              }),
          ...(page.cursor === undefined ? {} : { id: { gt: page.cursor } }),
        },
        include: CASE,
        orderBy: [{ slaDueAt: 'asc' }, { id: 'asc' }],
        take: page.limit + 1,
        ...(page.offset === null ? {} : { skip: page.offset }),
      }),
    );
  }

  countCases(scope: WarehouseScope, f: { status?: string; warehouseId?: string }) {
    return withPrismaErrors(() =>
      this.db.wmsComplianceCase.count({
        where: {
          ...scoped(scope, f.warehouseId),
          ...(f.status === undefined ? {} : { status: f.status as CaseRow['status'] }),
        },
        take: 10_001,
      }),
    );
  }

  async statusCounts(scope: WarehouseScope, warehouseId?: string) {
    const rows = await withPrismaErrors(() =>
      this.db.wmsComplianceCase.groupBy({
        by: ['status'],
        where: scoped(scope, warehouseId),
        _count: { _all: true },
      }),
    );
    return Object.fromEntries(rows.map((r) => [r.status, r._count._all])) as Record<string, number>;
  }

  async avgDecisionMinutes(
    scope: WarehouseScope,
    since: Date,
    warehouseId?: string,
  ): Promise<number | null> {
    const [r] = await this.db.$queryRaw<{ m: number | null }[]>`
      SELECT avg(EXTRACT(EPOCH FROM ("decidedAt" - "createdAt")) / 60)::float8 AS m
      FROM "warehouse_compliance_cases"
      WHERE "decidedAt" IS NOT NULL AND "decidedAt" >= ${since}
        ${warehouseId !== undefined ? Prisma.sql`AND "warehouseId" = ${warehouseId}::uuid` : scope === 'ALL' ? Prisma.empty : Prisma.sql`AND "warehouseId" = ANY(${[...scope]}::uuid[])`}`;
    return r?.m === null || r === undefined ? null : Math.round(r.m);
  }

  dueForEscalation(now: Date, limit: number) {
    return this.db.wmsComplianceCase.findMany({
      where: { status: { in: ['PENDING', 'FLAGGED'] }, slaDueAt: { lte: now } },
      select: { id: true },
      orderBy: { slaDueAt: 'asc' },
      take: limit,
    });
  }

  evidence(caseId: string) {
    return withPrismaErrors(() =>
      this.db.wmsComplianceEvidence.findMany({
        where: { caseId },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    );
  }

  async addEvidence(tx: Tx, data: Prisma.WmsComplianceEvidenceUncheckedCreateInput) {
    return tx.wmsComplianceEvidence.create({ data });
  }

  notes(caseId: string) {
    return withPrismaErrors(() =>
      this.db.wmsComplianceNote.findMany({
        where: { caseId },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    );
  }

  async addNote(tx: Tx, data: Prisma.WmsComplianceNoteUncheckedCreateInput) {
    return tx.wmsComplianceNote.create({ data });
  }

  inspectors() {
    return withPrismaErrors(() =>
      this.db.wmsComplianceInspector.findMany({ orderBy: { displayName: 'asc' } }),
    );
  }

  inspector(userId: string) {
    return withPrismaErrors(() => this.db.wmsComplianceInspector.findUnique({ where: { userId } }));
  }

  upsertInspector(
    tx: Tx,
    userId: string,
    data: Omit<Prisma.WmsComplianceInspectorUncheckedCreateInput, 'userId'>,
  ) {
    return tx.wmsComplianceInspector.upsert({
      where: { userId },
      create: { userId, ...data },
      update: { ...data, version: { increment: 1 } },
    });
  }

  async addWaiver(tx: Tx, data: Prisma.WmsComplianceWaiverUncheckedCreateInput) {
    await tx.wmsComplianceWaiver.create({ data, select: { id: true } });
  }

  waivers(caseId: string) {
    return withPrismaErrors(() =>
      this.db.wmsComplianceWaiver.findMany({ where: { caseId }, orderBy: { createdAt: 'desc' } }),
    );
  }
}
