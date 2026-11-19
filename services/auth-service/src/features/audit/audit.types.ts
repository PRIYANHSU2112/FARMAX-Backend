import type { CursorQuery } from '@farmx/common/types';

/** Actor id recorded for system actions (seed, background jobs). */
export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export const AUDIT_TARGET_TYPES = ['user', 'role', 'user_role', 'permission', 'session'] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/** Who performed an action and from where (built by controllers from the request). */
export interface AuditActor {
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/** One admin action. `action` is `<target>.<verb>`, e.g. `user.status_changed`. */
export interface AuditEntry {
  actor: AuditActor;
  action: string;
  targetType: AuditTargetType;
  targetId: string;
  subjectUserId?: string | null;
  before?: JsonObject | null;
  after?: JsonObject | null;
  reason?: string | null;
  /** Extra context. Never secrets or password hashes. */
  metadata?: JsonObject | null;
}

export interface AuditLogView {
  id: string;
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  subjectUserId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  metadata: unknown;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  createdAt: string;
}

export interface AuditListQuery extends CursorQuery {
  actorUserId?: string;
  subjectUserId?: string;
  targetType?: AuditTargetType;
  targetId?: string;
  action?: string;
  from?: Date;
  to?: Date;
}
