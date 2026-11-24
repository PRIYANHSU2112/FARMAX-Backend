/**
 * GST state codes. GSTINs, tax documents and the seller config use the 2-digit GST state code
 * ("37" = Andhra Pradesh), while addresses and territories store the 2-letter state code ("AP").
 * Compare states only after converting both sides with {@link toGstStateCode}.
 */

/** 2-letter state code (ISO 3166-2:IN, plus common alternates) → 2-digit GST state code. */
const LETTER_TO_GST: Readonly<Record<string, string>> = {
  JK: '01',
  HP: '02',
  PB: '03',
  CH: '04',
  UT: '05',
  UK: '05',
  HR: '06',
  DL: '07',
  RJ: '08',
  UP: '09',
  BR: '10',
  SK: '11',
  AR: '12',
  NL: '13',
  MN: '14',
  MZ: '15',
  TR: '16',
  ML: '17',
  AS: '18',
  WB: '19',
  JH: '20',
  OR: '21',
  OD: '21',
  CT: '22',
  CG: '22',
  MP: '23',
  GJ: '24',
  DH: '26',
  DN: '26',
  DD: '26',
  MH: '27',
  KA: '29',
  GA: '30',
  LD: '31',
  KL: '32',
  TN: '33',
  PY: '34',
  AN: '35',
  TG: '36',
  TS: '36',
  AP: '37',
  LA: '38',
};

const GST_CODES = new Set(Object.values(LETTER_TO_GST));

/**
 * The 2-digit GST state code for a state given either way ("AP" or "37"); null when unknown/empty.
 */
export const toGstStateCode = (code: string | null | undefined): string | null => {
  if (code === null || code === undefined) return null;
  const c = code.trim().toUpperCase();
  if (/^\d{2}$/.test(c)) return GST_CODES.has(c) ? c : null;
  return LETTER_TO_GST[c] ?? null;
};
