/**
 * FIXED permission catalog — the single source of truth for every permission key.
 *
 * Permissions are code, not data: adding/removing a key is a code change + `pnpm db:seed`,
 * which upserts every entry and marks keys no longer listed here as deprecated.
 * No runtime API creates, renames or deletes a permission. Roles are dynamic and are built
 * from these keys in the admin panel.
 *
 * Source: FarmX Admin Panel Role-wise Permissions §3 (module matrix) and §5 (key pattern),
 * PRD §16.2 (access matrix) and §17 (approval matrix).
 *
 * Rules:
 *  - key = `<module>.<action>`, lower snake_case.
 *  - sensitive: requires a reason, an audit entry and step-up MFA when exercised.
 *  - assignable=false: reserved for the seeded `super_admin` system role (PRD P8 "sole authority").
 *  - scopes: scopes the permission may be granted with. GLOBAL is always implied for super_admin.
 */

export type PermissionScope = 'GLOBAL' | 'WAREHOUSE' | 'REGION' | 'VENDOR' | 'OWN';

export interface PermissionDefinition {
  readonly key: string;
  readonly description: string;
  readonly sensitive?: boolean;
  readonly assignable?: boolean;
  readonly scopes?: readonly PermissionScope[];
}

export interface PermissionModule {
  readonly module: string;
  readonly label: string;
  readonly permissions: readonly PermissionDefinition[];
}

const G: readonly PermissionScope[] = ['GLOBAL'];
const GR: readonly PermissionScope[] = ['GLOBAL', 'REGION'];
const GW: readonly PermissionScope[] = ['GLOBAL', 'REGION', 'WAREHOUSE'];
const GV: readonly PermissionScope[] = ['GLOBAL', 'REGION', 'VENDOR'];
const GWO: readonly PermissionScope[] = ['GLOBAL', 'REGION', 'WAREHOUSE', 'OWN'];
const GRO: readonly PermissionScope[] = ['GLOBAL', 'REGION', 'OWN'];
const ALL: readonly PermissionScope[] = ['GLOBAL', 'REGION', 'WAREHOUSE', 'VENDOR', 'OWN'];

export const PERMISSION_CATALOG: readonly PermissionModule[] = [
  {
    module: 'dashboard',
    label: 'Dashboard & analytics',
    permissions: [
      { key: 'dashboard.view', description: 'View dashboards and KPI cards', scopes: ALL },
    ],
  },
  {
    module: 'users',
    label: 'Users',
    permissions: [
      { key: 'users.view', description: 'View admin/staff users', scopes: GR },
      {
        key: 'users.invite',
        description: 'Invite or create staff users',
        sensitive: true,
        scopes: G,
      },
      {
        key: 'users.update',
        description: 'Edit staff user profile and identifiers',
        sensitive: true,
        scopes: G,
      },
      {
        key: 'users.suspend',
        description: 'Suspend, reactivate or deactivate a user',
        sensitive: true,
        scopes: G,
      },
      {
        key: 'users.reset_mfa',
        description: 'Reset a user’s MFA enrolment',
        sensitive: true,
        scopes: G,
      },
      {
        key: 'users.devices_view',
        description: 'View a user’s devices and login history',
        scopes: GR,
      },
      {
        key: 'users.devices_block',
        description: 'Block, unblock or revoke a user’s device',
        sensitive: true,
        scopes: G,
      },
      { key: 'users.sessions_view', description: 'View a user’s active sessions', scopes: GR },
      {
        key: 'users.sessions_revoke',
        description: 'Force sign-out of a user’s sessions',
        sensitive: true,
        scopes: G,
      },
      { key: 'users.export', description: 'Export user lists', sensitive: true, scopes: G },
    ],
  },
  {
    module: 'roles',
    label: 'Roles & permissions',
    permissions: [
      { key: 'roles.view', description: 'View roles and their permissions', scopes: G },
      {
        key: 'roles.create',
        description: 'Create a dynamic role',
        sensitive: true,
        assignable: false,
        scopes: G,
      },
      {
        key: 'roles.update',
        description: 'Edit a role and its permission set',
        sensitive: true,
        assignable: false,
        scopes: G,
      },
      {
        key: 'roles.archive',
        description: 'Archive a role',
        sensitive: true,
        assignable: false,
        scopes: G,
      },
      {
        key: 'roles.assign',
        description: 'Assign or revoke roles for users',
        sensitive: true,
        assignable: false,
        scopes: G,
      },
      { key: 'permissions.view', description: 'View the fixed permission catalog', scopes: G },
    ],
  },
  {
    module: 'audit_logs',
    label: 'Audit logs',
    permissions: [
      { key: 'audit_logs.view', description: 'View audit and authentication logs', scopes: GR },
      { key: 'audit_logs.export', description: 'Export audit logs', sensitive: true, scopes: G },
    ],
  },
  {
    module: 'customers',
    label: 'Customer & farm profiles',
    permissions: [
      { key: 'customers.view', description: 'View customers and farm profiles', scopes: GRO },
      {
        key: 'customers.create',
        description: 'Register a customer or farm on their behalf',
        scopes: GRO,
      },
      { key: 'customers.update', description: 'Edit customer and farm profiles', scopes: GRO },
      {
        key: 'customers.verify',
        description: 'Approve/reject customer KYC documents',
        sensitive: true,
        scopes: GR,
      },
      {
        key: 'customers.suspend',
        description: 'Suspend a customer account',
        sensitive: true,
        scopes: G,
      },
      {
        key: 'customers.merge',
        description: 'Merge a duplicate farm registration into an existing Farm ID',
        sensitive: true,
        scopes: G,
      },
      {
        key: 'customers.credit_manage',
        description: 'Set customer credit limit and period',
        sensitive: true,
        scopes: G,
      },
      {
        key: 'customers.export',
        description: 'Export customer and farm data',
        sensitive: true,
        scopes: G,
      },
    ],
  },
  {
    module: 'territories',
    label: 'Territories & pin codes',
    permissions: [
      {
        key: 'territories.manage',
        description: 'Manage territories and pin-code → node mapping',
        sensitive: true,
        scopes: G,
      },
    ],
  },
  {
    module: 'vendors',
    label: 'Vendor onboarding & KYC',
    permissions: [
      { key: 'vendors.view', description: 'View vendors and onboarding applications', scopes: GV },
      {
        key: 'vendors.update',
        description: 'Edit vendor profile and commercial terms',
        scopes: GV,
      },
      {
        key: 'vendors.kyc_review',
        description: 'Review vendor documents and certifications',
        scopes: GV,
      },
      {
        key: 'vendors.approve',
        description: 'Approve or reject vendor onboarding',
        sensitive: true,
        scopes: G,
      },
      { key: 'vendors.suspend', description: 'Suspend a vendor', sensitive: true, scopes: G },
      { key: 'vendors.export', description: 'Export vendor data', sensitive: true, scopes: G },
    ],
  },
  {
    module: 'catalogue',
    label: 'Product catalogue & categories',
    permissions: [
      { key: 'catalogue.view', description: 'View products and categories', scopes: GV },
      { key: 'catalogue.create', description: 'Create items, variants and categories', scopes: G },
      { key: 'catalogue.update', description: 'Edit catalogue content', scopes: G },
      {
        key: 'catalogue.manage',
        description: 'Manage brands: create, edit, activate/feature and delete',
        scopes: G,
      },
      {
        key: 'catalogue.publish',
        description: 'Publish or suspend a catalogue item',
        sensitive: true,
        scopes: G,
      },
      {
        key: 'catalogue.corrections_approve',
        description: 'Approve vendor-raised corrections',
        scopes: GV,
      },
    ],
  },
  {
    module: 'pricing',
    label: 'Pricing, discounts & promotions',
    permissions: [
      { key: 'pricing.view', description: 'View price tiers, coupons and campaigns', scopes: GR },
      {
        key: 'pricing.manage',
        description: 'Draft price tiers, coupons and campaigns',
        scopes: GR,
      },
      {
        key: 'pricing.approve',
        description: 'Approve price tier creation or revision',
        sensitive: true,
        scopes: G,
      },
      {
        key: 'pricing.override',
        description: 'Override the resolved price on a transaction',
        sensitive: true,
        assignable: false,
        scopes: G,
      },
    ],
  },
  {
    module: 'inventory',
    label: 'Inventory & stock movements',
    permissions: [
      { key: 'inventory.view', description: 'View stock, batches and locations', scopes: ALL },
      {
        key: 'inventory.configure',
        description: 'Manage warehouses, PIN coverage, stock thresholds and inventory settings',
        sensitive: true,
        scopes: G,
      },
      { key: 'inventory.receive', description: 'Gate entry, receipt and put-away', scopes: GW },
      { key: 'inventory.pick', description: 'Pick, pack and scan out against FEFO', scopes: GW },
      {
        key: 'inventory.transfer',
        description: 'Initiate and receive inter-node transfers',
        scopes: GW,
      },
      {
        key: 'inventory.exception_raise',
        description: 'Raise a stock discrepancy or damage exception',
        scopes: GW,
      },
      {
        key: 'inventory.adjust',
        description: 'Adjust stock quantity against an exception',
        sensitive: true,
        assignable: false,
        scopes: G,
      },
      {
        key: 'inventory.quarantine_release',
        description: 'Release stock from quarantine',
        sensitive: true,
        assignable: false,
        scopes: G,
      },
      {
        key: 'inventory.write_off',
        description: 'Disposition expired or destroyed stock',
        sensitive: true,
        assignable: false,
        scopes: G,
      },
    ],
  },
  {
    module: 'orders',
    label: 'Orders & fulfilment',
    permissions: [
      { key: 'orders.view', description: 'View orders and order history', scopes: ALL },
      { key: 'orders.create', description: 'Place an order on behalf of a customer', scopes: GRO },
      {
        key: 'orders.update',
        description: 'Update order details and fulfilment status',
        scopes: GWO,
      },
      { key: 'orders.cancel', description: 'Cancel an order', sensitive: true, scopes: GR },
      {
        key: 'orders.confirm',
        description: 'Confirm or reject a paid order awaiting admin review',
        sensitive: true,
        scopes: GR,
      },
      {
        key: 'orders.configure',
        description: 'Change order settings (payment window, review SLA, cancellation policy)',
        sensitive: true,
        scopes: G,
      },
      {
        key: 'orders.credit_release',
        description: 'Release a credit-held order',
        sensitive: true,
        scopes: G,
      },
      { key: 'orders.export', description: 'Export orders', sensitive: true, scopes: GR },
    ],
  },
  {
    module: 'returns',
    label: 'Returns & order exceptions',
    permissions: [
      { key: 'returns.view', description: 'View returns and exceptions', scopes: ALL },
      { key: 'returns.manage', description: 'Raise and process returns', scopes: GWO },
      {
        key: 'returns.approve',
        description: 'Approve or reject a return',
        sensitive: true,
        scopes: GR,
      },
      {
        key: 'returns.biological_approve',
        description: 'Cold-chain assessment for returned biologicals',
        sensitive: true,
        scopes: G,
      },
    ],
  },
  {
    module: 'payments',
    label: 'Payments, refunds & settlements',
    permissions: [
      { key: 'payments.view', description: 'View payment transactions', scopes: GV },
      {
        key: 'payments.reconcile',
        description: 'Reconcile gateway and bank credits',
        sensitive: true,
        scopes: G,
      },
      { key: 'refunds.initiate', description: 'Initiate a refund', sensitive: true, scopes: GR },
      { key: 'refunds.approve', description: 'Approve a refund', sensitive: true, scopes: G },
      { key: 'settlements.view', description: 'View vendor settlements and payouts', scopes: GV },
      {
        key: 'settlements.approve',
        description: 'Release the vendor payout batch',
        sensitive: true,
        scopes: G,
      },
      {
        key: 'settlements.reverse',
        description: 'Reverse a settlement',
        sensitive: true,
        assignable: false,
        scopes: G,
      },
      {
        key: 'settlements.export',
        description: 'Export settlement and finance data',
        sensitive: true,
        scopes: G,
      },
    ],
  },
  {
    module: 'sales',
    label: 'Sales calls & quotations',
    permissions: [
      { key: 'sales.view', description: 'View call-backs, leads and quotations', scopes: GRO },
      { key: 'sales.manage', description: 'Manage call-backs, visits and quotations', scopes: GRO },
    ],
  },
  {
    module: 'logistics',
    label: 'Logistics, consignments & dispatch',
    permissions: [
      {
        key: 'logistics.consignment_view',
        description: 'View consignments and tracking',
        scopes: GWO,
      },
      {
        key: 'logistics.dispatch_assign',
        description: 'Assign driver, vehicle and route',
        scopes: GW,
      },
      {
        key: 'logistics.delivery_exception_manage',
        description: 'Manage failed/partial deliveries',
        scopes: GW,
      },
      {
        key: 'logistics.delivery_override',
        description: 'Complete a delivery without OTP (support override)',
        sensitive: true,
        scopes: G,
      },
      {
        key: 'logistics.fare_rate_manage',
        description: 'Change per-kilometre fare rates',
        sensitive: true,
        scopes: G,
      },
    ],
  },
  {
    module: 'drivers',
    label: 'Driver app & fleet',
    permissions: [
      { key: 'drivers.view', description: 'View drivers, vehicles and documents', scopes: GRO },
      {
        key: 'drivers.manage',
        description: 'Verify, activate or suspend logistics partners',
        sensitive: true,
        scopes: GR,
      },
      {
        key: 'drivers.pod_submit',
        description: 'Submit delivery OTP, POD and evidence',
        scopes: ['OWN'],
      },
    ],
  },
  {
    module: 'cold_chain',
    label: 'Cold-chain & temperature alerts',
    permissions: [
      { key: 'cold_chain.view', description: 'View temperature readings and alerts', scopes: GWO },
      { key: 'cold_chain.manage', description: 'Acknowledge and manage excursions', scopes: GW },
    ],
  },
  {
    module: 'quality',
    label: 'Quality holds, deviations & recalls',
    permissions: [
      { key: 'quality.view', description: 'View holds, deviations and CAPA', scopes: GW },
      {
        key: 'quality.hold_create',
        description: 'Place a quality hold',
        sensitive: true,
        scopes: GW,
      },
      {
        key: 'quality.hold_release',
        description: 'Release a quality hold',
        sensitive: true,
        scopes: G,
      },
      {
        key: 'quality.deviation_close',
        description: 'Close a deviation',
        sensitive: true,
        scopes: G,
      },
      {
        key: 'quality.recall_initiate',
        description: 'Initiate a recall',
        sensitive: true,
        scopes: G,
      },
      {
        key: 'quality.recall_approve',
        description: 'Approve a recall',
        sensitive: true,
        assignable: false,
        scopes: G,
      },
    ],
  },
  {
    module: 'traceability',
    label: 'COA, batch & traceability',
    permissions: [
      { key: 'traceability.coa_view', description: 'View certificates of analysis', scopes: ALL },
      {
        key: 'traceability.coa_publish',
        description: 'Publish a COA against a consignment',
        sensitive: true,
        scopes: G,
      },
      { key: 'traceability.coa_verify', description: 'Verify a COA', sensitive: true, scopes: G },
      {
        key: 'traceability.batch_export',
        description: 'Export batch traceability',
        sensitive: true,
        scopes: G,
      },
    ],
  },
  {
    module: 'prescriptions',
    label: 'Prescriptions & veterinary',
    permissions: [
      {
        key: 'prescriptions.view',
        description: 'View prescriptions and consultations',
        sensitive: true,
        scopes: GRO,
      },
      {
        key: 'prescriptions.manage',
        description: 'Write, countersign or cancel prescriptions',
        sensitive: true,
        scopes: ['OWN'],
      },
      {
        key: 'prescriptions.export',
        description: 'Export prescription data',
        sensitive: true,
        scopes: G,
      },
    ],
  },
  {
    module: 'loyalty',
    label: 'Membership, wallet & loyalty',
    permissions: [
      { key: 'loyalty.view', description: 'View tiers, points and wallets', scopes: GR },
      {
        key: 'loyalty.manage',
        description: 'Configure tiers, rules and adjustments',
        sensitive: true,
        scopes: G,
      },
    ],
  },
  {
    module: 'recurring_orders',
    label: 'Recurring orders',
    permissions: [
      { key: 'recurring_orders.view', description: 'View repeat schedules', scopes: GRO },
      {
        key: 'recurring_orders.manage',
        description: 'Pause, amend or cancel schedules',
        scopes: GRO,
      },
    ],
  },
  {
    module: 'content',
    label: 'Content, news & knowledge base',
    permissions: [
      { key: 'content.view', description: 'View articles and drafts', scopes: G },
      { key: 'content.manage', description: 'Create and edit content', scopes: G },
      { key: 'content.publish', description: 'Publish or unpublish content', scopes: G },
    ],
  },
  {
    module: 'support',
    label: 'Support tickets',
    permissions: [
      { key: 'support.view', description: 'View tickets', scopes: GRO },
      { key: 'support.manage', description: 'Reply, assign and close tickets', scopes: GRO },
    ],
  },
  {
    module: 'notifications',
    label: 'Notifications',
    permissions: [
      { key: 'notifications.view', description: 'View templates and delivery logs', scopes: G },
      {
        key: 'notifications.manage',
        description: 'Manage templates and send campaigns',
        scopes: G,
      },
    ],
  },
  {
    module: 'reports',
    label: 'Reports & data export',
    permissions: [
      { key: 'reports.view', description: 'View reports', scopes: ALL },
      { key: 'reports.export', description: 'Export reports', sensitive: true, scopes: ALL },
    ],
  },
  {
    module: 'settings',
    label: 'System settings & integrations',
    permissions: [
      { key: 'settings.view', description: 'View system configuration', scopes: G },
      {
        key: 'settings.manage',
        description: 'Change system configuration',
        sensitive: true,
        assignable: false,
        scopes: G,
      },
      {
        key: 'integrations.manage',
        description: 'Manage integration credentials and status',
        sensitive: true,
        assignable: false,
        scopes: G,
      },
    ],
  },
];

export interface FlatPermission {
  key: string;
  module: string;
  action: string;
  description: string;
  isSensitive: boolean;
  assignable: boolean;
  allowedScopes: PermissionScope[];
  sortOrder: number;
}

/** Flattened catalog, in display order. */
export const PERMISSIONS: readonly FlatPermission[] = PERMISSION_CATALOG.flatMap(
  (group, groupIndex) =>
    group.permissions.map((permission, index) => {
      const dot = permission.key.indexOf('.');
      return {
        key: permission.key,
        module: group.module,
        action: permission.key.slice(dot + 1),
        description: permission.description,
        isSensitive: permission.sensitive ?? false,
        assignable: permission.assignable ?? true,
        allowedScopes: [...(permission.scopes ?? G)],
        sortOrder: groupIndex * 100 + index,
      };
    }),
);

export const PERMISSION_KEYS: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p.key));

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

/** The only seeded role. Holds every permission (including non-assignable ones) at GLOBAL scope. */
export const SUPER_ADMIN_ROLE = {
  key: 'super_admin',
  name: 'Super Admin',
  description:
    'Platform configuration and access governance. Sole authority for inventory adjustment, price override, settlement reversal, quarantine release and role changes. Fully audited.',
  audience: 'INTERNAL',
  isSystem: true,
  mfaRequired: true,
  sessionIdleMinutes: 15,
} as const;
