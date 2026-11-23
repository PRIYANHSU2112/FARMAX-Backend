import { describe, expect, it } from 'vitest';

import { SupportUploads } from '../../src/features/media/media.support.js';

type Deps = ConstructorParameters<typeof SupportUploads>[0];

const uploads = new SupportUploads({
  config: { BUCKET_FOLDER_PATH: 'farmx' },
  logger: {},
  storage: { signedGetUrl: (key: string) => Promise.resolve(`https://signed/${key}`) },
} as unknown as Deps);

describe('private uploads (support evidence + staff documents)', () => {
  it('keeps each purpose in its own folder', () => {
    expect(uploads.prefixOf('support')).toBe('farmx/support/');
    expect(uploads.prefixOf('staff_document')).toBe('farmx/staff/');
    expect(uploads.prefix).toBe('farmx/support/');
  });

  it('signs only private keys (never public catalogue or other folders)', async () => {
    const urls = await uploads.signRead(
      ['farmx/support/a.pdf', 'farmx/staff/b.pdf', 'farmx/products/c.webp', 'other/staff/d.pdf'],
      300,
    );
    expect(Object.keys(urls)).toEqual(['farmx/support/a.pdf', 'farmx/staff/b.pdf']);
  });
});
