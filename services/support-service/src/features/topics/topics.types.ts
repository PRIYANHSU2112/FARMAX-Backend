import type { App } from '../../middleware/http.js';
import type { Priority, RuleConditions, Team } from './topics.rules.js';
import type { SlaPolicySnapshot } from './topics.sla.js';

export interface TopicView {
  id: string;
  app: App;
  code: string;
  label: string;
  description: string | null;
  icon: string | null;
  sortOrder: number;
  defaultPriority: Priority;
  team: Team;
  requiresOrder: boolean;
  allowsEvidence: boolean;
  isCommonIssue: boolean;
  isActive: boolean;
  updatedAt: Date;
}

export interface TopicInput {
  app: App;
  code: string;
  label: string;
  description?: string | null;
  icon?: string | null;
  sortOrder?: number;
  defaultPriority?: Priority;
  team?: Team;
  requiresOrder?: boolean;
  allowsEvidence?: boolean;
  isCommonIssue?: boolean;
  isActive?: boolean;
  reason?: string;
}

export interface RuleView {
  id: string;
  name: string;
  app: App | null;
  topicCode: string | null;
  conditions: RuleConditions;
  priority: Priority;
  reasonLabel: string;
  team: Team | null;
  sortOrder: number;
  isActive: boolean;
  updatedAt: Date;
}

export interface RuleInput {
  name: string;
  app?: App | null;
  topicCode?: string | null;
  conditions: RuleConditions;
  priority: Priority;
  reasonLabel: string;
  team?: Team | null;
  sortOrder?: number;
  isActive?: boolean;
  reason?: string;
}

export interface SlaPolicyView extends SlaPolicySnapshot {
  app: App;
  priority: Priority;
  updatedAt: Date | null;
}

export interface SlaPolicyInput {
  calendarId: string | null;
  firstResponseMins: number;
  resolveMins: number;
  businessHoursOnly: boolean;
  reason: string;
}

/** Used until an admin saves a policy for (app, priority). Wall clock, no calendar. */
export const DEFAULT_SLA: Record<Priority, { firstResponseMins: number; resolveMins: number }> = {
  URGENT: { firstResponseMins: 15, resolveMins: 240 },
  HIGH: { firstResponseMins: 60, resolveMins: 480 },
  MEDIUM: { firstResponseMins: 240, resolveMins: 1440 },
  LOW: { firstResponseMins: 480, resolveMins: 4320 },
};
