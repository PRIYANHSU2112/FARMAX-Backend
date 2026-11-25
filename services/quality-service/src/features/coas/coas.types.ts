export interface ResultInput {
  paramCode: string;
  valueNum?: number | null;
  valueText?: string | null;
}

export interface CertificateFields {
  certificateRef?: string;
  issuerName?: string;
  analystName?: string;
  signatoryName?: string;
  issuedAt?: string;
  validUntil?: string;
}

export interface UploadInput extends CertificateFields {
  /** media-service upload receipt of the PDF (purpose `wms_document`). */
  receipt: string;
  /** Batch number as printed on the certificate (auto-link key). */
  batchNo: string;
  variantId?: string;
  cnNo?: string;
}

export interface ResultsInput extends CertificateFields {
  results: ResultInput[];
  expectedVersion: number;
}

export interface SampleResultsInput extends ResultsInput {
  /** Lab report PDF (optional). */
  receipt?: string;
}

export interface ReviewInput {
  decision: 'APPROVE' | 'REJECT';
  note: string;
  expectedVersion: number;
}

export interface CoaListQuery {
  batchId?: string;
  status?: 'UPLOADED' | 'LINKED' | 'RESULTS_ENTERED' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  source?: 'MANUFACTURER' | 'INDEPENDENT';
  expiringWithinDays?: number;
  q?: string;
  cursor?: string;
  limit: number;
}
