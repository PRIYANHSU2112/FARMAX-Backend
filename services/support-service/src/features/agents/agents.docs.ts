import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN } from '../../docs/shared.js';
import { APPS, TEAMS } from '../../middleware/http.js';

export const ADMIN_AGENTS_TAG = 'Admin Support Agents';

const agentSchema = Joi.object({
  userId: Joi.string().guid(),
  displayName: Joi.string().example('Swathi'),
  teams: Joi.array().items(Joi.string().valid(...TEAMS)),
  apps: Joi.array().items(Joi.string().valid(...APPS)),
  maxConcurrent: Joi.number().integer().example(8),
  acceptingChats: Joi.boolean(),
  openCount: Joi.number().integer(),
  isActive: Joi.boolean(),
  online: Joi.boolean().description('An agent console socket is open'),
  updatedAt: Joi.date().iso(),
}).meta({ className: 'SupportAgent' });

const cannedSchema = Joi.object({
  id: Joi.string().guid(),
  app: Joi.string().valid(...APPS).allow(null),
  topicCode: Joi.string().allow(null),
  title: Joi.string().example('Cold-chain quarantine'),
  body: Joi.string(),
  isActive: Joi.boolean(),
  updatedAt: Joi.date().iso(),
}).meta({ className: 'SupportCannedReply' });

const base = { tag: ADMIN_AGENTS_TAG, auth: AUTH_ADMIN } as const;

export const AGENT_DOCS = {
  list: { ...base, permission: 'support.view', summary: 'List support agents', description: 'Roster with live load (`openCount`) and presence (`online`).', success: { status: 200, description: 'Agents', data: Joi.array().items(agentSchema) } },
  save: {
    ...base,
    permission: 'support.configure',
    summary: 'Add or edit an agent',
    description: 'Staff user → agent: teams they serve (SUPPORT, VET …), apps, concurrent ticket cap. Auto-assign picks the least-loaded online agent that is accepting chats. Audited.',
    requestExample: { displayName: 'Dr. K. Srinivas', teams: ['VET'], apps: ['CUSTOMER'], maxConcurrent: 6, isActive: true },
    success: { status: 200, description: 'Saved', data: agentSchema },
    errors: [422],
  },
  me: { ...base, permission: 'support.manage', summary: 'My agent profile', description: 'For the agent console header (load, accepting toggle).', success: { status: 200, description: 'Agent', data: agentSchema } },
  availability: {
    ...base,
    permission: 'support.manage',
    summary: 'Accept new chats on / off',
    description: 'Auto-assign only picks agents who accept AND are online (agent console WebSocket open). Already assigned tickets stay.',
    requestExample: { acceptingChats: true },
    success: { status: 200, description: 'Agent', data: agentSchema },
    errors: [422],
  },
  listCanned: { ...base, permission: 'support.view', summary: 'Canned replies', description: 'Filter by app / topic (rows for every app / topic included).', success: { status: 200, description: 'Replies', data: Joi.array().items(cannedSchema) } },
  createCanned: { ...base, permission: 'support.configure', summary: 'Add a canned reply', description: 'Audited.', requestExample: { app: 'CUSTOMER', topicCode: 'DELIVERY_RETURNS', title: 'Cold-chain quarantine', body: 'Please do not use them. Quarantine the vials; a fresh batch is on its way.' }, success: { status: 201, description: 'Created', data: cannedSchema }, errors: [422] },
  updateCanned: { ...base, permission: 'support.configure', summary: 'Edit or turn off a canned reply', description: 'Audited.', success: { status: 200, description: 'Updated', data: cannedSchema }, errors: [404, 422] },
} satisfies Record<string, RouteDocs>;
