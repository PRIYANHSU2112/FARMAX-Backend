import type { App } from '../../middleware/http.js';

export const LEGAL_KINDS = ['PRIVACY_POLICY', 'TERMS', 'REFUND_POLICY', 'SHIPPING_POLICY'] as const;
export type LegalKind = (typeof LEGAL_KINDS)[number];

export interface LegalSection {
  heading: string;
  body: string;
}

export interface LegalView {
  id: string;
  kind: LegalKind;
  app: App | null;
  version: number;
  title: string;
  intro: string | null;
  sections: LegalSection[];
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  effectiveFrom: Date | null;
  publishedAt: Date | null;
  publishedBy: string | null;
  updatedAt: Date;
}

export interface LegalDraftInput {
  kind: LegalKind;
  app?: App | null;
  title: string;
  intro?: string | null;
  sections: LegalSection[];
  effectiveFrom?: Date | null;
}
