import type { App } from '../../middleware/http.js';

export interface FaqCategoryView {
  id: string;
  app: App;
  code: string;
  title: string;
  sortOrder: number;
  isActive: boolean;
}

export interface FaqView {
  id: string;
  app: App;
  categoryId: string;
  question: string;
  answer: string;
  tags: string[];
  topicCodes: string[];
  sortOrder: number;
  helpfulCount: number;
  notHelpfulCount: number;
}

export interface FaqAdminView extends FaqView {
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface FaqListQuery {
  app: App;
  categoryId?: string;
  q?: string;
  cursor?: string;
  limit: number;
}

export interface CategoryInput {
  app: App;
  code: string;
  title: string;
  sortOrder?: number;
  isActive?: boolean;
}

export interface FaqInput {
  app: App;
  categoryId: string;
  question: string;
  answer: string;
  tags?: string[];
  topicCodes?: string[];
  sortOrder?: number;
  isActive?: boolean;
}
