import type { ParamVerdict, mismatch } from '../specs/index.js';

export type CardStatus = 'PASS' | 'LAB_PENDING' | 'FAILED' | 'QUARANTINED' | 'NO_CERTIFICATE';

/** One batch as the customer / verify page sees it. Contains NO buyer data. */
export interface Card {
  batchId: string;
  batchNo: string;
  mfgDate: string | null;
  expiryDate: string | null;
  vendorName: string | null;
  cnNos: string[];
  product: {
    name: string;
    variantName: string;
    brandName: string | null;
    packLabel: string | null;
    imageUrl: string | null;
    coldChain: string | null;
  } | null;
  status: CardStatus;
  statusText: string;
  releasedOn: string | null;
  quarantine: { since: string | null; text: string; advice: string } | null;
  certificates: {
    source: string;
    label: string;
    issuer: string | null;
    selfDeclared: boolean;
    accreditation: string | null;
    analystName: string | null;
    signatoryName: string | null;
    signedOn: string | null;
    labRef: string | null;
    verdict: string;
    documentUrl: string | null;
  }[];
  parameters: {
    code: string;
    name: string;
    unit: string | null;
    spec: string;
    manufacturer: { value: string | number | null; verdict: ParamVerdict } | null;
    independent: { value: string | number | null; verdict: ParamVerdict } | null;
    failed: boolean;
  }[];
  whatFailed: { name: string; value: string | number | null; spec: string }[];
  mismatch: ReturnType<typeof mismatch>;
  pending: {
    step: number;
    of: number;
    labName: string | null;
    expectedResultAt: string | null;
    steps: { label: string; detail: string | null; state: string }[];
  } | null;
  timeline: { at: string; title: string; detail: string }[];
  policy: string;
}
