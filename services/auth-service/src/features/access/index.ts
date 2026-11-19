// Public API of the access feature. Other features import ONLY from here.
export { accessInternalModule, accessModule } from './access.module.js';
export { requirePermission } from './access.guard.js';
export type { AccessService } from './access.service.js';
export type {
  RoleAssignment,
  RoleAudience,
  RoleChoice,
  ScopeType,
  SetUserRolesResult,
  UserAccess,
} from './access.types.js';
export { roleChoiceSchema } from './access.validation.js';
export { ADMIN_ROLES_TAG } from './access.docs.js';
export { SUPER_ADMIN_ROLE } from './permissions.catalog.js';
