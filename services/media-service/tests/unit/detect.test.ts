import { describe, expect, it } from 'vitest';

import {
  resolveAllowedType,
  sniffMime,
  typeForExtension,
} from '../../src/features/media/processing/detect.js';
import { makeImage, makePdf } from '../helpers/fixtures.js';

const mp4Head = Buffer.concat([
  Buffer.from([0, 0, 0, 0x20]),
  Buffer.from('ftypisom'),
  Buffer.alloc(8),
]);

describe('signature detection (magic bytes)', () => {
  it('recognises the five allowed types', async () => {
    expect(sniffMime(await makeImage(4, 4, 'jpeg'))).toBe('image/jpeg');
    expect(sniffMime(await makeImage(4, 4, 'png'))).toBe('image/png');
    expect(sniffMime(await makeImage(4, 4, 'webp'))).toBe('image/webp');
    expect(sniffMime(mp4Head)).toBe('video/mp4');
    expect(sniffMime(makePdf())).toBe('application/pdf');
  });

  it('rejects executables, QuickTime and HEIC containers', () => {
    expect(sniffMime(Buffer.from('MZ\x90\x00 executable'))).toBeNull();
    expect(
      sniffMime(Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  ')])),
    ).toBeNull();
    expect(
      sniffMime(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic')])),
    ).toBeNull();
  });
});

describe('allowlist (extension + declared MIME + signature must agree)', () => {
  it('accepts a consistent JPEG', async () => {
    const head = await makeImage(4, 4, 'jpeg');
    expect(
      resolveAllowedType({ filename: 'Photo.JPG', mimetype: 'image/jpeg', head }),
    ).toMatchObject({ kind: 'image' });
  });

  it('refuses disallowed extensions (415)', () => {
    expect(() => typeForExtension('payload.exe')).toThrow(/not allowed/);
    expect(() => typeForExtension('noextension')).toThrow(/not allowed/);
    expect(() => typeForExtension('photo.heic')).toThrow(/not allowed/);
  });

  it('refuses a renamed file, a lying Content-Type, or unknown content', async () => {
    const png = await makeImage(4, 4, 'png');
    expect(() =>
      resolveAllowedType({ filename: 'a.jpg', mimetype: 'image/jpeg', head: png }),
    ).toThrow(/do not match/);
    expect(() =>
      resolveAllowedType({ filename: 'a.png', mimetype: 'image/jpeg', head: png }),
    ).toThrow(/do not match/);
    expect(() =>
      resolveAllowedType({
        filename: 'a.pdf',
        mimetype: 'application/pdf',
        head: Buffer.from('MZ'),
      }),
    ).toThrow(/not a JPEG/);
  });
});
