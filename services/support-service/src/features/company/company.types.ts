export const COMPANY_DOC_TYPES = ['DRUG_LICENSE', 'GST', 'COI', 'FSSAI', 'ISO', 'OTHER'] as const;
export type CompanyDocType = (typeof COMPANY_DOC_TYPES)[number];

export const APPLICATION_TYPES = ['DEALER', 'DISTRIBUTOR', 'PARTNER'] as const;
export type ApplicationType = (typeof APPLICATION_TYPES)[number];

export const APPLICATION_STATUSES = ['SUBMITTED', 'APPROVED', 'REJECTED'] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
export type ReviewDecision = Exclude<ApplicationStatus, 'SUBMITTED'>;

export interface CompanyDocView {
  id: string;
  type: CompanyDocType;
  title: string;
  documentNo: string;
  issuingAuthority: string;
  expiresAt: Date | null;
  fileUrl: string;
  isPublic: boolean;
  createdBy: string;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What apps see: no staff ids. */
export type PublicCompanyDoc = Omit<
  CompanyDocView,
  'isPublic' | 'createdBy' | 'updatedBy' | 'createdAt'
>;

export interface CompanyDocInput {
  type: CompanyDocType;
  title: string;
  documentNo: string;
  issuingAuthority: string;
  expiresAt?: Date | null;
  fileUrl: string;
  isPublic?: boolean;
}

export interface DocListQuery {
  type?: CompanyDocType;
  isPublic?: boolean;
}

/** One stored attachment (private media key; never returned as is). */
export interface StoredDoc {
  key: string;
  fileName: string | null;
  mime: string;
  size: number;
}

export interface ApplicationRow {
  id: string;
  applicantUserId: string;
  businessName: string;
  applicationType: ApplicationType;
  attachedDocs: StoredDoc[];
  status: ApplicationStatus;
  reviewNotes: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** An attachment as returned: a 5-minute signed URL instead of the key. */
export interface AttachedDocView {
  fileName: string | null;
  mime: string;
  size: number;
  url: string | null;
}

export type ApplicationView = Omit<ApplicationRow, 'attachedDocs'> & {
  attachedDocs: AttachedDocView[];
};

/** The applicant's own view: no reviewer id. */
export type MyApplicationView = Omit<ApplicationView, 'reviewedBy'>;

/** Review queue row: attachment count only (URLs are signed on the detail call). */
export type ApplicationSummary = Omit<ApplicationRow, 'attachedDocs'> & {
  attachmentCount: number;
};

export interface ApplyInput {
  businessName: string;
  applicationType: ApplicationType;
  /** Upload receipts from media-service (`purpose=support`). */
  attachments: string[];
}

export interface ApplicationQueueQuery {
  status?: ApplicationStatus;
  type?: ApplicationType;
  cursor?: string;
  limit: number;
}

export interface ReviewInput {
  status: ReviewDecision;
  reviewNotes?: string | null;
}
