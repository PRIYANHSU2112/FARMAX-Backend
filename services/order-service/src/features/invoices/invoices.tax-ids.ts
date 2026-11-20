/** GST identifiers (pure): GSTIN format + checksum, state codes, HSN / SAC format. */

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The GSTN check character for the first 14 characters (Luhn mod-36). */
export const gstinCheckChar = (first14: string): string => {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const product = CHARS.indexOf(first14.charAt(i)) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARS.charAt((36 - (sum % 36)) % 36);
};

/** Format, a known state code and the checksum. */
export const isValidGstin = (gstin: string): boolean =>
  GSTIN.test(gstin) &&
  STATE_NAMES[gstin.slice(0, 2)] !== undefined &&
  gstinCheckChar(gstin.slice(0, 14)) === gstin.charAt(14);

/** HSN (goods) / SAC (services) as printed on invoices: 4, 6 or 8 digits. */
export const isValidHsn = (code: string): boolean => /^(\d{4}|\d{6}|\d{8})$/.test(code);

/** GST state / UT codes (place of supply). */
export const STATE_NAMES: Readonly<Record<string, string>> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
};

/** Financial year code (April–March, IST) of an instant: 2026-11-19 → "2627". */
export const financialYear = (at: Date): string => {
  const ist = new Date(at.getTime() + 330 * 60_000);
  const year = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? year : year - 1;
  const yy = (n: number) => String(n % 100).padStart(2, '0');
  return `${yy(start)}${yy(start + 1)}`;
};

/** FX/2627/0000123 — ≤ 16 characters (GST rule 46: serial, unique per financial year). */
export const formatDocNo = (series: string, fy: string, seq: number): string => {
  const docNo = `${series}/${fy}/${String(seq).padStart(7, '0')}`;
  if (docNo.length > 16) throw new Error(`document number ${docNo} exceeds 16 characters`);
  return docNo;
};
