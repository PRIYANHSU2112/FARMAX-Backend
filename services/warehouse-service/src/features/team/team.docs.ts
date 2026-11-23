import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { staffDoc } from '../../docs/shared.js';

export const ADMIN_TEAM_TAG = 'Admin Warehouse Team';

const T = ADMIN_TEAM_TAG;
const manage = 'warehouse.team_manage';

const member = Joi.object({
  userId: Joi.string().guid(),
  fullName: Joi.string().allow(null).example('Pooja Verma'),
  email: Joi.string().allow(null),
  phone: Joi.string().allow(null).example('+919876543210'),
  roles: Joi.array().items(
    Joi.object({ roleId: Joi.string().guid(), roleKey: Joi.string(), roleName: Joi.string() }),
  ),
  workAreas: Joi.array().items(Joi.string()).description('Empty = "All Areas"'),
  shiftId: Joi.string().guid().allow(null),
  documentStatus: Joi.string().valid('COMPLETE', 'PENDING'),
  documents: Joi.array().items(Joi.object({ docType: Joi.string(), uploadedAt: Joi.date().iso() })),
  status: Joi.string().valid('ACTIVE', 'INACTIVE'),
  accountStatus: Joi.string().valid('INVITED', 'ACTIVE', 'SUSPENDED', 'UNKNOWN'),
}).meta({ className: 'TeamMember' });

const AUTH_RULES =
  'auth-service re-checks that the caller holds warehouse.team_manage AT THIS warehouse and that the role grants nothing the caller lacks there (403 PRIVILEGE_ESCALATION).';

export const TEAM_DOCS = {
  list: staffDoc(T, 'Warehouse team (W2.06)', 'warehouse.view', {
    data: Joi.array().items(member),
    description:
      'Members (a role at this warehouse) first, then removed ones (INACTIVE). Document status is COMPLETE once ID proof, address proof and photo are uploaded.',
  }),
  roles: staffDoc(T, 'Role templates + module access (read-only)', 'warehouse.view', {
    description:
      'Roles that can be granted at a warehouse, with the Figma module checkboxes and usage. READ-ONLY here: roles are global, so central admins edit them with auth PUT /admin/roles/:id/permissions after GET /admin/roles/:id/usage.',
  }),
  add: staffDoc(T, 'Add employee (invite)', manage, {
    status: 201,
    data: member,
    errors: [400, 404, 409, 422, 503],
    description: `Creates or reuses the staff account, grants the role here and emails a 48 h invitation code (Accept invitation screen). ${AUTH_RULES}`,
  }),
  update: staffDoc(T, 'Edit employee', manage, {
    data: member,
    errors: [400, 404, 409, 422, 503],
    description: `Work areas, shift, phone, or a new role (the old ones here are removed). ${AUTH_RULES}`,
  }),
  remove: staffDoc(T, 'Remove employee', manage, {
    data: member,
    errors: [404, 422, 503],
    description:
      'Removes every role at this warehouse and ends their sessions; the row stays INACTIVE. Nobody removes their own access.',
  }),
  resend: staffDoc(T, 'Resend invitation', manage, {
    errors: [404, 409, 422, 503],
    description: 'New code for a member who has not accepted yet (429 inside the 30 s cooldown).',
  }),
  putDocument: staffDoc(T, 'Attach a document', manage, {
    data: member,
    errors: [404, 422, 503],
    description:
      'Upload first: media-service POST /v1/upload?purpose=staff_document (private, virus-scanned PDFs, ≤ 10 MB), then send its `receipt`. A re-upload replaces that document type.',
  }),
  documents: staffDoc(T, "A member's documents", manage, {
    description: 'Each with a 5-minute signed URL.',
  }),
} satisfies Record<string, RouteDocs>;
