// Public API of the audit module. Other modules import ONLY from here.
export { auditModule } from './audit.module.js';
export type { AuditService } from './audit.service.js';
export {
  SYSTEM_ACTOR_ID,
  type AuditActor,
  type AuditEntry,
  type AuditTargetType,
  type JsonObject,
} from './audit.types.js';
export { ADMIN_AUDIT_TAG } from './audit.docs.js';
export { actorFromRequest } from './audit.actor.js';
