import { open } from 'node:fs/promises';
import { extname } from 'node:path';

import { UnsupportedMediaTypeError } from '@farmx/common/errors';

import { ALLOWED_TYPES, type AllowedType, PRIVATE_ONLY_TYPES } from '../media.types.js';

/** ISO-BMFF brands accepted as MP4 (not QuickTime `qt  `, not HEIC/AVIF images). */
const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'M4V ',
  'dash',
  'mmp4',
]);

const ascii = (buffer: Buffer, start: number, end: number) => buffer.toString('latin1', start, end);

/** Identifies the real content type from the first bytes (magic numbers). */
export function sniffMime(head: Buffer): string | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    return 'image/jpeg';
  if (
    head.length >= 8 &&
    head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (head.length >= 12 && ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP')
    return 'image/webp';
  if (head.length >= 12 && ascii(head, 4, 8) === 'ftyp' && MP4_BRANDS.has(ascii(head, 8, 12)))
    return 'video/mp4';
  if (head.length >= 5 && ascii(head, 0, 5) === '%PDF-') return 'application/pdf';
  if (
    head.length >= 4 &&
    ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0x00) ||
      (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0x00 && head[3] === 0x2a))
  )
    return 'image/tiff';
  return null;
}

/** Allowlist entry for a file name's extension, or 415. Checked before the body is stored. */
export function typeForExtension(filename: string, purpose?: string): AllowedType {
  const extension = extname(filename).toLowerCase();
  const allowed =
    ALLOWED_TYPES.find((type) => type.extensions.includes(extension)) ??
    (purpose === undefined
      ? undefined
      : PRIVATE_ONLY_TYPES.find(
          (type) => type.extensions.includes(extension) && type.purposes.includes(purpose),
        ));
  if (allowed === undefined) {
    throw new UnsupportedMediaTypeError(
      `File extension "${extension || '(none)'}" is not allowed. Allowed: .jpg .jpeg .png .webp .mp4 .pdf`,
    );
  }
  return allowed;
}

export async function readHead(path: string, bytes = 32): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Extension, declared MIME type and the detected signature must ALL agree with one allowlist entry.
 * A renamed executable, a PNG declared as JPEG or a PDF named `.jpg` are refused (415).
 */
export function resolveAllowedType(
  input: {
    filename: string;
    mimetype: string;
    head: Buffer;
  },
  purpose?: string,
): AllowedType {
  const byExtension = typeForExtension(input.filename, purpose);
  const declared = input.mimetype.split(';')[0]?.trim().toLowerCase() ?? '';
  const detected = sniffMime(input.head);
  if (detected === null) {
    throw new UnsupportedMediaTypeError('File content is not a JPEG, PNG, WebP, MP4 or PDF');
  }
  if (detected !== byExtension.mime || declared !== byExtension.mime) {
    throw new UnsupportedMediaTypeError(
      `File content (${detected}), declared type (${declared || 'none'}) and extension do not match`,
    );
  }
  return byExtension;
}
