import type { DocsOptions, ServiceModule } from '@farmx/common/server';

import type { SupportConfig } from '../config/index.js';
import { ADMIN_AGENTS_TAG, agentsModule } from '../features/agents/index.js';
import { auditModule } from '../features/audit/index.js';
import { CHAT_TAG, chatModule } from '../features/chat/index.js';
import { ADMIN_FAQ_TAG, FAQ_TAG, faqsModule } from '../features/faqs/index.js';
import { ADMIN_LEGAL_TAG, LEGAL_TAG, legalModule } from '../features/legal/index.js';
import { ADMIN_SUPPORT_CONFIG_TAG, settingsModule } from '../features/settings/index.js';
import { ADMIN_TICKETS_TAG, TICKETS_TAG, ticketsModule } from '../features/tickets/index.js';
import { HELP_TAG, topicsModule } from '../features/topics/index.js';

/**
 * support-service: Help & Support for every app (customer, vendor, logistics, warehouse).
 *   /support/config|suggestions        public   home config, "These may answer it"
 *   /faqs/*  /legal/*                  public   FAQ (search, votes) and legal pages
 *   /support/tickets/*                 requester own tickets, messages, feedback
 *   /support/chat/ws-token|ws          any      live chat (shared @farmx/infra/realtime layer)
 *   /support/admin/*  /faqs/admin/*  /legal/admin/*   staff (permissions)
 */
export const features: readonly ServiceModule[] = [
  auditModule,
  settingsModule,
  topicsModule,
  faqsModule,
  legalModule,
  agentsModule,
  ticketsModule,
  chatModule,
];

/** Spec only (`/api-docs.json`); the gateway merges it into the single FarmX Swagger UI. */
export const createDocsOptions = (config: SupportConfig): DocsOptions => ({
  title: 'FarmX Support Service API',
  version: config.SERVICE_VERSION,
  description:
    'Help & Support for all apps: priority-driven tickets with SLA (business hours, holidays), live chat over WebSocket, FAQ with search and deflection, versioned legal pages.',
  tags: [
    { name: 'Health', description: 'Public liveness and readiness probes.' },
    { name: HELP_TAG, description: 'Help & Support home: contacts, chat switch, topics, Common Issues.' },
    { name: FAQ_TAG, description: 'FAQ list, search, "These may answer it", helpful votes.' },
    { name: LEGAL_TAG, description: 'Privacy Policy, Terms and other legal pages.' },
    { name: TICKETS_TAG, description: 'Raise and follow tickets (Open / Resolved), messages, feedback.' },
    { name: CHAT_TAG, description: 'Live chat WebSocket: connect token + protocol.' },
    { name: ADMIN_TICKETS_TAG, description: 'Agent queue: claim, assign, escalate, priority, status, intake.' },
    { name: ADMIN_AGENTS_TAG, description: 'Agents, availability, canned replies.' },
    { name: ADMIN_SUPPORT_CONFIG_TAG, description: 'Settings, calendars, topics, priority rules, SLA policies.' },
    { name: ADMIN_FAQ_TAG, description: 'FAQ categories and items.' },
    { name: ADMIN_LEGAL_TAG, description: 'Legal document drafts and publishing.' },
  ],
});
