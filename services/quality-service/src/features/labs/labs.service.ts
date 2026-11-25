import { NotFoundError } from '@farmx/common/errors';
import { type RunInTransaction, type Tx, isUniqueViolation } from '@farmx/database';

import { type Caller, actorOf } from '../../middleware/guards.js';
import { conflict, versionConflict } from '../../middleware/http.js';
import type { AuditService } from '../audit/index.js';
import type { SamplesService } from '../samples/index.js';
import type { LabsRepository } from './labs.repository.js';
import type { LabInput, LabUpdate } from './labs.types.js';

/** The LIMS connector is Future (manual result entry only, user decision 2026-11-25). */
const CONNECTOR = {
  mode: 'MANUAL',
  status: 'NOT_AVAILABLE',
  lastSyncAt: null,
  note: 'Results are entered by QA. A LIMS connection (API / webhook / auto sync) is planned.',
} as const;

type LabRow = NonNullable<Awaited<ReturnType<LabsRepository['byId']>>>;

/** W16.08: laboratories samples are sent to (in-house FarmX QA Lab or accredited outside labs). */
export class LabsService {
  constructor(
    private readonly deps: {
      labsRepository: LabsRepository;
      runInTransaction: RunInTransaction;
      auditService: AuditService;
      samplesService: SamplesService;
    },
  ) {}

  async list(q: { status?: 'ACTIVE' | 'INACTIVE' }) {
    const labs = await this.deps.labsRepository.list(q.status);
    const latest = await this.deps.samplesService.latestPerLab(labs.map((l) => l.id));
    return labs.map((l) => this.view(l, latest.get(l.id) ?? null));
  }

  async get(id: string) {
    const lab = await this.deps.labsRepository.byId(id);
    if (lab === null) throw new NotFoundError('Laboratory');
    const latest = await this.deps.samplesService.latestPerLab([id]);
    return this.view(lab, latest.get(id) ?? null);
  }

  /** An ACTIVE lab (sample create / send). */
  async requireActive(id: string) {
    const lab = await this.deps.labsRepository.byId(id);
    if (lab === null) throw new NotFoundError('Laboratory');
    if (lab.status !== 'ACTIVE') throw conflict('LAB_INACTIVE', 'This laboratory is inactive');
    return lab;
  }

  /** For other features: the preferred lab if active, else the first active one. */
  firstActive(tx: Tx, preferId: string | null) {
    return this.deps.labsRepository.firstActive(tx, preferId);
  }

  async byIds(ids: readonly string[]) {
    if (ids.length === 0) return new Map<string, LabRow>();
    return new Map((await this.deps.labsRepository.byIds([...new Set(ids)])).map((l) => [l.id, l]));
  }

  async create(caller: Caller, input: LabInput) {
    const { runInTransaction, auditService, labsRepository } = this.deps;
    try {
      return await runInTransaction(async (tx) => {
        const lab = await labsRepository.create(tx, {
          ...input,
          createdBy: caller.userId,
          updatedBy: caller.userId,
        });
        await auditService.record(tx, actorOf(caller), {
          action: 'lab.created',
          targetType: 'lab',
          targetId: lab.id,
          after: lab,
        });
        return this.view(lab, null);
      });
    } catch (err) {
      if (isUniqueViolation(err))
        throw conflict('CODE_TAKEN', `Lab code ${input.code} is already used`);
      throw err;
    }
  }

  async update(caller: Caller, id: string, input: LabUpdate) {
    const { runInTransaction, auditService, labsRepository } = this.deps;
    const { expectedVersion, ...data } = input;
    return runInTransaction(async (tx) => {
      const before = await labsRepository.byId(id, tx);
      if (before === null) throw new NotFoundError('Laboratory');
      if (
        !(await labsRepository.updateVersioned(tx, id, expectedVersion, {
          ...data,
          updatedBy: caller.userId,
        }))
      )
        throw versionConflict(before.version);
      const after = await labsRepository.byId(id, tx);
      if (after === null) throw new NotFoundError('Laboratory');
      await auditService.record(tx, actorOf(caller), {
        action: 'lab.updated',
        targetType: 'lab',
        targetId: id,
        before,
        after,
      });
      return this.view(after, null);
    });
  }

  /** "Test lab connection": manual labs have no connector yet. */
  async testConnection(id: string) {
    await this.get(id);
    return { labId: id, ...CONNECTOR };
  }

  private view(l: LabRow, latest: { sampleNo: string; at: Date } | null) {
    return {
      id: l.id,
      code: l.code,
      name: l.name,
      accreditation: l.accreditation,
      type: l.type,
      tatDays: l.tatDays,
      contactName: l.contactName,
      contactPhone: l.contactPhone,
      contactEmail: l.contactEmail,
      address: l.address,
      status: l.status,
      version: l.version,
      connector: CONNECTOR,
      /** W16.08 "Sample mapping": the latest sample sent to this lab. */
      latestSample:
        latest === null ? null : { sampleNo: latest.sampleNo, at: latest.at.toISOString() },
      updatedAt: l.updatedAt.toISOString(),
    };
  }
}
