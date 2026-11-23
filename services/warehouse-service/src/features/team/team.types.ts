export type WorkArea = 'RECEIVING' | 'STORAGE' | 'PICKING' | 'DISPATCH';
export const WORK_AREAS: readonly WorkArea[] = ['RECEIVING', 'STORAGE', 'PICKING', 'DISPATCH'];

export type StaffDocType = 'ID_PROOF' | 'ADDRESS_PROOF' | 'PHOTO';
/** A member's documents are COMPLETE when every one of these is uploaded. */
export const REQUIRED_DOCS: readonly StaffDocType[] = ['ID_PROOF', 'ADDRESS_PROOF', 'PHOTO'];

/** Figma "module access" checkboxes → the permission keys behind them. */
export const MODULE_CATALOG = [
  { module: 'RECEIVING', label: 'Receiving (Inbound)', permissions: ['inventory.receive'] },
  { module: 'PICKING', label: 'Picking (Order fulfilment)', permissions: ['inventory.pick'] },
  {
    module: 'STOCK_CHANGES',
    label: 'Stock changes (Adjustment / Transfer)',
    permissions: ['inventory.transfer', 'inventory.exception_raise'],
  },
  { module: 'DISPATCH', label: 'Dispatch (Outbound)', permissions: ['logistics.dispatch_assign'] },
] as const;

export interface AddMemberInput {
  fullName: string;
  email: string;
  phone?: string | null;
  roleId: string;
  workAreas?: WorkArea[];
  shiftId?: string | null;
}

export interface UpdateMemberInput {
  phone?: string | null;
  workAreas?: WorkArea[];
  shiftId?: string | null;
  /** Change the member's role at this warehouse (grant the new one, remove the others). */
  roleId?: string;
  reason?: string;
}

/** W2.06 team table row. */
export interface MemberView {
  userId: string;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  roles: { roleId: string; roleKey: string; roleName: string }[];
  /** Empty = all areas ("All Areas"). */
  workAreas: WorkArea[];
  shiftId: string | null;
  documentStatus: 'COMPLETE' | 'PENDING';
  documents: { docType: StaffDocType; uploadedAt: string }[];
  /** ACTIVE = holds a role here; INACTIVE = removed (kept for history). */
  status: 'ACTIVE' | 'INACTIVE';
  /** INVITED until the person accepts the emailed code. */
  accountStatus: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'UNKNOWN';
}
