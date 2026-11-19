export type KycDocType =
  'PAN_CARD' | 'GST_CERTIFICATE' | 'ID_PROOF_FRONT' | 'ID_PROOF_BACK' | 'OTHER';
export type KycDocStatus = 'UPLOADED' | 'ACCEPTED' | 'REJECTED' | 'SUPERSEDED';

export interface KycDocumentView {
  id: string;
  farmId: string | null;
  docType: KycDocType;
  contentType: string;
  sizeBytes: number;
  status: KycDocStatus;
  rejectionCode: string | null;
  rejectionNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface DocumentInput {
  docType: KycDocType;
  storageKey: string;
  sha256: string;
  contentType: string;
  sizeBytes: number;
}

export interface GstView {
  verificationId: string;
  gstin: string;
  tradeName: string | null;
  legalName: string;
  /** Same as legalName (GST "Legal Name of Business"); the name stored on the farm. */
  businessName: string;
  /** GST state code (first 2 digits of the GSTIN). */
  stateCode: string;
  /** null = farm has no location yet; false = billing will be refused (ITC invalid). */
  stateMatchesFarm: boolean | null;
  portalStatus: 'ACTIVE' | 'CANCELLED' | 'SUSPENDED' | 'INACTIVE';
  checkedAt: string;
  nameMatchesFarm: boolean;
  panMatchesGstin: boolean | null;
  options: ('GST_TRADE_NAME' | 'FARM_NAME')[];
}

export interface BillingInput {
  verificationId: string;
  invoiceNameSource: 'FARM_NAME' | 'GST_TRADE_NAME';
}

export interface DocumentDecisionInput {
  decision: 'ACCEPT' | 'REJECT';
  rejectionCode?: string;
  note?: string;
  reason: string;
}

export interface AadhaarTxn {
  txnRef: string;
  last4: string;
  attempts: number;
}
