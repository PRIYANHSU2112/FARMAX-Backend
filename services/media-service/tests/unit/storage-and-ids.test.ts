import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import { SpacesStorage, buildPublicUrl } from '../../src/adapters/spaces.js';
import { uuidv7 } from '../../src/features/media/processing/uuidv7.js';

const config = {
  AWS_ENDPOINT: 'https://blr1.digitaloceanspaces.com',
  AWS_REGION: 'blr1',
  AWS_BUCKET_NAME: 'farmx',
  AWS_ACCESS_KEY_ID: 'key',
  AWS_SECRET_ACCESS_KEY: 'secret',
};

describe('uuidv7', () => {
  it('is RFC 9562 v7 (version 7, variant 10xx) and time-ordered', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
    expect(a.replace(/-/g, '').slice(0, 12)).toBe(
      (1_700_000_000_000).toString(16).padStart(12, '0'),
    );
  });

  it('never collides in a burst', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => uuidv7()));
    expect(ids.size).toBe(10_000);
  });
});

describe('Spaces adapter', () => {
  it('builds the bucket URL, or the CDN URL when configured', () => {
    expect(buildPublicUrl(config, 'dev/x.webp')).toBe(
      'https://farmx.blr1.digitaloceanspaces.com/dev/x.webp',
    );
    expect(
      buildPublicUrl({ ...config, MEDIA_PUBLIC_BASE_URL: 'https://cdn.farmx.in/' }, 'dev/x.webp'),
    ).toBe('https://cdn.farmx.in/dev/x.webp');
  });

  it('uploads with PutObjectCommand, ACL public-read and immutable caching', async () => {
    const send = vi.fn(() => Promise.resolve({}));
    const storage = new SpacesStorage(config, { send } as unknown as S3Client);
    await storage.putPublicObject({
      key: 'dev/a.webp',
      body: Buffer.from('x'),
      contentType: 'image/webp',
    });
    const [command] = send.mock.calls[0] as unknown as [PutObjectCommand];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: 'farmx',
      Key: 'dev/a.webp',
      ACL: 'public-read',
      ContentType: 'image/webp',
      ContentLength: 1,
      CacheControl: 'public, max-age=31536000, immutable',
    });
  });
});

describe('config', () => {
  it('normalises BUCKET_FOLDER_PATH ("dev/" → "dev")', async () => {
    const { loadConfig } = await import('../../src/config/index.js');
    const config = loadConfig({
      AWS_ENDPOINT: 'https://blr1.digitaloceanspaces.com',
      AWS_REGION: 'blr1',
      AWS_BUCKET_NAME: 'farmx',
      AWS_ACCESS_KEY_ID: 'k',
      AWS_SECRET_ACCESS_KEY: 's',
      BUCKET_FOLDER_PATH: '/dev/',
    });
    expect(config.BUCKET_FOLDER_PATH).toBe('dev');
  });
});
