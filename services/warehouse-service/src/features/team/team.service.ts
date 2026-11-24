import { NotFoundError } from '@farmx/common/errors';
import type { Cradle } from '@fastify/awilix';

import type { ScopeMember, StaffContact } from '../../adapters/auth-client.js';
import type { Caller } from '../../middleware/guards.js';
import type { Actor } from '../audit/index.js';
import type { DocRow, ProfileRow } from './team.repository.js';
import {
  type AddMemberInput,
  MODULE_CATALOG,
  type MemberView,
  REQUIRED_DOCS,
  type StaffDocType,
  type UpdateMemberInput,
} from './team.types.js';

const actorOf = (c: Caller): Actor => ({ userId: c.userId, ip: c.ip, requestId: c.requestId });
const toE164 = (phone: string | null | undefined) =>
  phone === undefined || phone === null ? phone : phone.startsWith('+') ? phone : `+91${phone}`;

const accountStatus = (c: StaffContact | undefined): MemberView['accountStatus'] => {
  if (c === undefined) return 'UNKNOWN';
  if (c.status === 'PENDING_VERIFICATION') return 'INVITED';
  if (c.status === 'ACTIVE') return 'ACTIVE';
  return 'SUSPENDED';
};

export function memberView(
  userId: string,
  member: ScopeMember | undefined,
  profile: ProfileRow | undefined,
  contact: StaffContact | undefined,
  docs: readonly DocRow[],
): MemberView {
  const have = new Set(docs.map((d) => d.docType));
  return {
    userId,
    fullName: contact?.fullName ?? null,
    email: contact?.email ?? null,
    phone: profile?.phone ?? contact?.phone ?? null,
    roles: (member?.roles ?? []).map((r) => ({
      roleId: r.roleId,
      roleKey: r.roleKey,
      roleName: r.roleName,
    })),
    workAreas: profile?.workAreas ?? [],
    shiftId: profile?.shiftId ?? null,
    jobTitle: profile?.jobTitle ?? null,
    documentStatus: REQUIRED_DOCS.every((d) => have.has(d)) ? 'COMPLETE' : 'PENDING',
    documents: docs.map((d) => ({ docType: d.docType, uploadedAt: d.uploadedAt.toISOString() })),
    status: member === undefined ? 'INACTIVE' : 'ACTIVE',
    accountStatus: accountStatus(contact),
  };
}

/**
 * Warehouse Team (W2.06 / wizard step 4, D-56). Accounts and roles live in auth-service
 * (invite-only; auth re-checks team_manage at this warehouse and refuses privilege escalation);
 * this feature keeps the warehouse facts: work areas, shift, contact phone, identity documents.
 * Role templates are global: the permissions panel here is read-only.
 */
export class TeamService {
  private readonly repo: Cradle['teamRepository'];
  private readonly runInTransaction: Cradle['runInTransaction'];
  private readonly auditService: Cradle['auditService'];
  private readonly authClient: Cradle['authClient'];
  private readonly mediaClient: Cradle['mediaClient'];
  private readonly lazy: Pick<Cradle, 'warehousesService' | 'calendarService'>;

  constructor(
    deps: Pick<
      Cradle,
      | 'teamRepository'
      | 'runInTransaction'
      | 'auditService'
      | 'authClient'
      | 'mediaClient'
      | 'warehousesService'
      | 'calendarService'
    >,
  ) {
    this.repo = deps.teamRepository;
    this.runInTransaction = deps.runInTransaction;
    this.auditService = deps.auditService;
    this.authClient = deps.authClient;
    this.mediaClient = deps.mediaClient;
    this.lazy = deps;
  }

  /** Current members (a role here) and removed ones (kept as INACTIVE). */
  async list(caller: Caller, warehouseId: string): Promise<MemberView[]> {
    await this.visible(caller, warehouseId, 'warehouse.view');
    const [members, profiles, docs] = await Promise.all([
      this.authClient.scopeMembers(warehouseId),
      this.repo.profiles(warehouseId),
      this.repo.documents(warehouseId),
    ]);
    const ids = [...new Set([...members.map((m) => m.userId), ...profiles.map((p) => p.userId)])];
    const contacts = await this.authClient.contacts(ids);
    const byMember = new Map(members.map((m) => [m.userId, m] as const));
    const byProfile = new Map(profiles.map((p) => [p.userId, p] as const));
    return ids
      .map((id) =>
        memberView(
          id,
          byMember.get(id),
          byProfile.get(id),
          contacts.get(id),
          docs.filter((d) => d.userId === id),
        ),
      )
      .sort(
        (a, b) =>
          (a.status === b.status ? 0 : a.status === 'ACTIVE' ? -1 : 1) ||
          (a.fullName ?? '').localeCompare(b.fullName ?? ''),
      );
  }

  /** The role templates with the Figma module checkboxes (read-only here). */
  async roles(caller: Caller) {
    const templates = await this.authClient.warehouseRoles();
    return {
      editable: false,
      editInCentralConsole: caller.access.isGlobal('roles.update'),
      moduleCatalog: MODULE_CATALOG,
      roles: templates.map((t) => ({
        ...t,
        modules: Object.fromEntries(
          MODULE_CATALOG.map((m) => [
            m.module,
            m.permissions.every((p) => t.permissions.includes(p)),
          ]),
        ),
      })),
    };
  }

  /** "+ Add Employee": auth creates or reuses the account, grants the role here, emails the code. */
  async add(caller: Caller, warehouseId: string, input: AddMemberInput): Promise<MemberView> {
    await this.visible(caller, warehouseId, 'warehouse.team_manage');
    if (input.shiftId != null)
      await this.lazy.calendarService.requireShift(warehouseId, input.shiftId);
    const invited = await this.authClient.invite({
      email: input.email,
      fullName: input.fullName,
      roleId: input.roleId,
      warehouseId,
      invitedByUserId: caller.userId,
      requestId: caller.requestId,
    });
    await this.runInTransaction(async (tx) => {
      await this.repo.upsertProfile(
        tx,
        { warehouseId, userId: invited.userId },
        {
          phone: toE164(input.phone) ?? null,
          workAreas: [...new Set(input.workAreas ?? [])],
          shiftId: input.shiftId ?? null,
          jobTitle: input.jobTitle === '' ? null : (input.jobTitle ?? null),
          status: 'ACTIVE',
          byUserId: caller.userId,
        },
      );
      await this.auditService.record(tx, actorOf(caller), {
        action: 'staff.add',
        targetType: 'staff',
        targetId: invited.userId,
        after: {
          warehouseId,
          roleId: input.roleId,
          created: invited.created,
          invitationSent: invited.invitationSent,
        },
      });
    });
    await this.authClient.forget([invited.userId]);
    return this.member(warehouseId, invited.userId);
  }

  async update(
    caller: Caller,
    warehouseId: string,
    userId: string,
    input: UpdateMemberInput,
  ): Promise<MemberView> {
    await this.visible(caller, warehouseId, 'warehouse.team_manage');
    const current = await this.requireKnown(warehouseId, userId);
    if (input.shiftId != null)
      await this.lazy.calendarService.requireShift(warehouseId, input.shiftId);
    if (input.roleId !== undefined && !current.roles.some((r) => r.roleId === input.roleId)) {
      const contact = (await this.authClient.contacts([userId])).get(userId);
      if (contact?.email == null) throw new NotFoundError('Team member');
      await this.authClient.invite({
        email: contact.email,
        fullName: contact.fullName,
        roleId: input.roleId,
        warehouseId,
        invitedByUserId: caller.userId,
        requestId: caller.requestId,
      });
      for (const old of current.roles)
        await this.authClient.revoke({
          userId,
          warehouseId,
          roleId: old.roleId,
          revokedByUserId: caller.userId,
          reason: input.reason ?? 'role changed in warehouse team',
          requestId: caller.requestId,
        });
    }
    await this.runInTransaction(async (tx) => {
      await this.repo.upsertProfile(
        tx,
        { warehouseId, userId },
        {
          ...(input.phone === undefined ? {} : { phone: toE164(input.phone) }),
          ...(input.workAreas === undefined ? {} : { workAreas: [...new Set(input.workAreas)] }),
          ...(input.shiftId === undefined ? {} : { shiftId: input.shiftId }),
          ...(input.jobTitle === undefined
            ? {}
            : { jobTitle: input.jobTitle === '' ? null : input.jobTitle }),
          byUserId: caller.userId,
        },
      );
      await this.auditService.record(tx, actorOf(caller), {
        action: 'staff.update',
        targetType: 'staff',
        targetId: userId,
        before: { roles: current.roles, workAreas: current.workAreas, shiftId: current.shiftId },
        after: { warehouseId, ...input },
        reason: input.reason ?? null,
      });
    });
    return this.member(warehouseId, userId);
  }

  /** Removes every role here (auth ends the member's sessions); the row stays INACTIVE. */
  async remove(
    caller: Caller,
    warehouseId: string,
    userId: string,
    reason: string,
  ): Promise<MemberView> {
    await this.visible(caller, warehouseId, 'warehouse.team_manage');
    await this.requireKnown(warehouseId, userId);
    await this.authClient.revoke({
      userId,
      warehouseId,
      revokedByUserId: caller.userId,
      reason,
      requestId: caller.requestId,
    });
    await this.runInTransaction(async (tx) => {
      await this.repo.upsertProfile(
        tx,
        { warehouseId, userId },
        { status: 'INACTIVE', byUserId: caller.userId },
      );
      await this.auditService.record(tx, actorOf(caller), {
        action: 'staff.remove',
        targetType: 'staff',
        targetId: userId,
        after: { warehouseId },
        reason,
      });
    });
    return this.member(warehouseId, userId);
  }

  async resend(caller: Caller, warehouseId: string, userId: string) {
    await this.visible(caller, warehouseId, 'warehouse.team_manage');
    return this.authClient.resend({
      userId,
      warehouseId,
      requestedByUserId: caller.userId,
      requestId: caller.requestId,
    });
  }

  /** Attach an identity document (private media-service upload; the receipt proves it). */
  async putDocument(
    caller: Caller,
    warehouseId: string,
    userId: string,
    input: { docType: StaffDocType; receipt: string },
  ): Promise<MemberView> {
    await this.visible(caller, warehouseId, 'warehouse.team_manage');
    await this.requireKnown(warehouseId, userId);
    const file = this.mediaClient.verify(input.receipt, caller.userId, 'body.receipt');
    await this.runInTransaction(async (tx) => {
      const replaced = await this.repo.putDocument(tx, {
        warehouseId,
        userId,
        docType: input.docType,
        mediaKey: file.key,
        mime: file.mime,
        sizeBytes: file.size,
        uploadedByUserId: caller.userId,
      });
      await this.auditService.record(tx, actorOf(caller), {
        action: 'staff.document',
        targetType: 'staff',
        targetId: userId,
        after: { warehouseId, docType: input.docType, replaced: replaced !== null },
      });
    });
    return this.member(warehouseId, userId);
  }

  /** The member's documents with 5-minute signed URLs (team managers only). */
  async documents(caller: Caller, warehouseId: string, userId: string) {
    await this.visible(caller, warehouseId, 'warehouse.team_manage');
    const docs = await this.repo.documents(warehouseId, [userId]);
    const urls = await this.mediaClient.signRead(docs.map((d) => d.mediaKey));
    return docs.map((d) => ({
      docType: d.docType,
      mime: d.mime,
      sizeBytes: d.sizeBytes,
      uploadedAt: d.uploadedAt.toISOString(),
      url: urls[d.mediaKey] ?? null,
    }));
  }

  // ── Helpers ──

  private async member(warehouseId: string, userId: string): Promise<MemberView> {
    const [members, profile, docs, contacts] = await Promise.all([
      this.authClient.scopeMembers(warehouseId),
      this.repo.profile(warehouseId, userId),
      this.repo.documents(warehouseId, [userId]),
      this.authClient.contacts([userId]),
    ]);
    return memberView(
      userId,
      members.find((m) => m.userId === userId),
      profile ?? undefined,
      contacts.get(userId),
      docs,
    );
  }

  /** A current or former member of this warehouse; 404 for anyone else. */
  private async requireKnown(warehouseId: string, userId: string): Promise<MemberView> {
    const view = await this.member(warehouseId, userId);
    if (view.status === 'INACTIVE' && (await this.repo.profile(warehouseId, userId)) === null)
      throw new NotFoundError('Team member');
    return view;
  }

  private visible(caller: Caller, warehouseId: string, key: string) {
    return this.lazy.warehousesService.requireVisible(caller, warehouseId, key);
  }
}
