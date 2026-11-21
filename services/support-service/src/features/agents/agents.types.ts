import type { App } from '../../middleware/http.js';
import type { Team } from '../topics/index.js';

export interface AgentView {
  userId: string;
  displayName: string;
  teams: Team[];
  apps: App[];
  maxConcurrent: number;
  acceptingChats: boolean;
  openCount: number;
  isActive: boolean;
  online?: boolean;
  updatedAt: Date;
}

export interface AgentInput {
  displayName: string;
  teams: Team[];
  apps: App[];
  maxConcurrent?: number;
  isActive?: boolean;
}

export interface CannedReplyView {
  id: string;
  app: App | null;
  topicCode: string | null;
  title: string;
  body: string;
  isActive: boolean;
  updatedAt: Date;
}

export interface CannedReplyInput {
  app?: App | null;
  topicCode?: string | null;
  title: string;
  body: string;
  isActive?: boolean;
}
