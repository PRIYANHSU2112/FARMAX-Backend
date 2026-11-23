/** POST /internal/staff/invitations (warehouse-service "Add employee", D-56). */
export interface InviteStaffInput {
  email: string;
  fullName: string;
  /** A warehouse role template (every permission allows WAREHOUSE scope). */
  roleId: string;
  warehouseId: string;
  /** The staff user who pressed "Add employee" (re-checked here: team_manage + no escalation). */
  invitedByUserId: string;
  reason?: string;
  requestId?: string;
}

export interface InviteStaffResult {
  userId: string;
  /** A new account was created (PENDING_VERIFICATION until the invitation is accepted). */
  created: boolean;
  /** The role was newly granted at this warehouse (false = already held). */
  granted: boolean;
  /** An invitation code was emailed (pending accounts only). */
  invitationSent: boolean;
  status: string;
}

export interface ResendInvitationInput {
  userId: string;
  warehouseId: string;
  requestedByUserId: string;
  requestId?: string;
}

export interface RevokeStaffInput {
  userId: string;
  warehouseId: string;
  /** Only this role; omitted = every role the user holds at the warehouse. */
  roleId?: string;
  revokedByUserId: string;
  reason: string;
  requestId?: string;
}

/** The permission a caller needs at the warehouse to invite or remove staff. */
export const TEAM_MANAGE_PERMISSION = 'warehouse.team_manage';
