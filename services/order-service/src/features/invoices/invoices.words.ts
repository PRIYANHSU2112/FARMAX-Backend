/** Rupee amounts in words, Indian numbering (lakh, crore): for the "Amount in words" line. */

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

const belowHundred = (n: number): string =>
  n < 20
    ? (ONES[n] ?? '')
    : `${TENS[Math.floor(n / 10)] ?? ''}${n % 10 === 0 ? '' : `-${ONES[n % 10] ?? ''}`}`;

const belowThousand = (n: number): string => {
  const hundred = Math.floor(n / 100);
  const rest = n % 100;
  return [hundred > 0 ? `${ONES[hundred] ?? ''} Hundred` : '', rest > 0 ? belowHundred(rest) : '']
    .filter(Boolean)
    .join(' ');
};

/** Whole number in words, Indian system: 1,23,45,678 → One Crore Twenty-Three Lakh … */
export const numberInWords = (value: bigint): string => {
  if (value === 0n) return 'Zero';
  const parts: string[] = [];
  let n = value;
  const crore = n / 10_000_000n;
  n %= 10_000_000n;
  if (crore > 0n) parts.push(`${numberInWords(crore)} Crore`);
  const lakh = Number(n / 100_000n);
  n %= 100_000n;
  if (lakh > 0) parts.push(`${belowHundred(lakh)} Lakh`);
  const thousand = Number(n / 1000n);
  n %= 1000n;
  if (thousand > 0) parts.push(`${belowHundred(thousand)} Thousand`);
  if (n > 0n) parts.push(belowThousand(Number(n)));
  return parts.join(' ');
};

/** 2782150 paise → "Rupees Twenty-Seven Thousand Eight Hundred Twenty-One and Fifty Paise Only". */
export const amountInWords = (paise: bigint): string => {
  const rupees = paise / 100n;
  const rest = Number(paise % 100n);
  return `Rupees ${numberInWords(rupees)}${rest > 0 ? ` and ${belowHundred(rest)} Paise` : ''} Only`;
};
