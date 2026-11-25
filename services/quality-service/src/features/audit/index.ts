// Public API of the audit feature. Other features import ONLY from here.
export { AUDIT_AREA } from './audit.docs.js';
export { auditAdminModule, auditModule } from './audit.module.js';
export { type Actor, type AuditEntry, type AuditService, SYSTEM } from './audit.service.js';
