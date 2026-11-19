import { generateJwtKeys, signJwt } from '@farmx/common/auth';
import { asValue } from 'awilix';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.js';
import { FakeRedis } from '../helpers/fake-redis.js';
import { makeImage, makePdf, makeVideo, multipartBody } from '../helpers/fixtures.js';

const keys = generateJwtKeys('test-kid');
const ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  AWS_ENDPOINT: 'https://blr1.digitaloceanspaces.com',
  AWS_REGION: 'blr1',
  AWS_BUCKET_NAME: 'farmx',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  BUCKET_FOLDER_PATH: 'dev',
  JWT_KEY_ID: 'test-kid',
  JWT_PUBLIC_KEY: Buffer.from(
    keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  ).toString('base64'),
} as NodeJS.ProcessEnv;

const token = (scope: 'full' | 'mfa_enroll' = 'full') => {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    {
      iss: 'farmx-auth',
      aud: 'farmx',
      sub: 'u1',
      sid: 's1',
      jti: `j-${Math.random()}`,
      typ: 'INTERNAL',
      roles: [],
      scope,
      iat: now,
      exp: now + 900,
    },
    keys,
  );
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build() {
  app = await buildApp(ENV);
  const redis = new FakeRedis();
  const storage = {
    putPublicObject: vi.fn(() => Promise.resolve()),
    publicUrl: (key: string) => `https://farmx.blr1.digitaloceanspaces.com/${key}`,
  };
  app.diContainer.register({ redis: asValue(redis as never), storage: asValue(storage) });
  return { app, redis, storage };
}

const upload = (
  target: FastifyInstance,
  file: Parameters<typeof multipartBody>[0],
  options: { auth?: string | null; query?: string } = {},
) => {
  const { body, contentType } = multipartBody(file);
  const auth = options.auth === undefined ? token() : options.auth;
  return target.inject({
    method: 'POST',
    url: `/upload${options.query ?? ''}`,
    payload: body,
    headers: {
      'content-type': contentType,
      ...(auth === null ? {} : { authorization: `Bearer ${auth}` }),
    },
  });
};

const UUID_V7 = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

describe('POST /upload', () => {
  it('JPEG → WebP ≤1920×1080 at dev/<uuidv7>.webp, public-read, 201', async () => {
    const t = await build();
    const res = await upload(t.app, {
      filename: 'farm.jpg',
      contentType: 'image/jpeg',
      content: await makeImage(3000, 2000),
    });
    expect(res.statusCode).toBe(201);
    const { data } = res.json<{ data: Record<string, unknown> }>();
    expect(data.key).toMatch(new RegExp(`^dev/${UUID_V7}\\.webp$`));
    expect(data).toMatchObject({
      kind: 'image',
      contentType: 'image/webp',
      width: 1620,
      height: 1080,
    });
    expect(data.url).toBe(`https://farmx.blr1.digitaloceanspaces.com/${String(data.key)}`);
    expect(t.storage.putPublicObject).toHaveBeenCalledWith(
      expect.objectContaining({ key: data.key, contentType: 'image/webp' }),
    );
  });

  it('PDF is stored unchanged', async () => {
    const t = await build();
    const pdf = makePdf();
    const res = await upload(t.app, {
      filename: 'coa.pdf',
      contentType: 'application/pdf',
      content: pdf,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ data: { size: number; key: string } }>().data).toMatchObject({
      size: pdf.length,
    });
  });

  it('MP4 → H.264 MP4 (201)', async () => {
    const t = await build();
    const res = await upload(t.app, {
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      content: await makeVideo(640, 360, 1),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ data: Record<string, unknown> }>().data).toMatchObject({
      kind: 'video',
      contentType: 'video/mp4',
      width: 640,
      height: 360,
    });
  }, 60_000);

  it('401 without a token, 403 with an enrolment-only token', async () => {
    const t = await build();
    const file = { filename: 'a.jpg', contentType: 'image/jpeg', content: await makeImage(10, 10) };
    expect((await upload(t.app, file, { auth: null })).statusCode).toBe(401);
    expect((await upload(t.app, file, { auth: 'not.a.jwt' })).statusCode).toBe(401);
    expect((await upload(t.app, file, { auth: token('mfa_enroll') })).statusCode).toBe(403);
  });

  it('401 when the session was revoked (logout elsewhere)', async () => {
    const t = await build();
    await t.redis.set('farmx:auth:v1:revoked:sid:s1', '1', 'EX', 900);
    const res = await upload(t.app, {
      filename: 'a.jpg',
      contentType: 'image/jpeg',
      content: await makeImage(10, 10),
    });
    expect(res.statusCode).toBe(401);
  });

  it('415 for a renamed executable, a forbidden extension, or a lying Content-Type', async () => {
    const t = await build();
    const exe = Buffer.from('MZ\x90\x00\x03\x00\x00\x00 this is not an image');
    expect(
      (await upload(t.app, { filename: 'cat.jpg', contentType: 'image/jpeg', content: exe }))
        .statusCode,
    ).toBe(415);
    expect(
      (
        await upload(t.app, {
          filename: 'run.exe',
          contentType: 'application/octet-stream',
          content: exe,
        })
      ).statusCode,
    ).toBe(415);
    const png = await makeImage(10, 10, 'png');
    const lying = await upload(t.app, {
      filename: 'x.png',
      contentType: 'image/jpeg',
      content: png,
    });
    expect(lying.statusCode).toBe(415);
    expect(lying.json()).toMatchObject({
      success: false,
      error: { code: 'UNSUPPORTED_MEDIA_TYPE' },
    });
    expect(t.storage.putPublicObject).not.toHaveBeenCalled();
  });

  it('413 for an image over 5 MB (stopped while streaming)', async () => {
    const t = await build();
    const big = Buffer.concat([await makeImage(10, 10), Buffer.alloc(6 * 1024 * 1024)]);
    const res = await upload(t.app, {
      filename: 'big.jpg',
      contentType: 'image/jpeg',
      content: big,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
  });

  it('422 when ?type does not match the file', async () => {
    const t = await build();
    const res = await upload(
      t.app,
      { filename: 'coa.pdf', contentType: 'application/pdf', content: makePdf() },
      { query: '?type=image' },
    );
    expect(res.statusCode).toBe(422);
  });

  it('400 without a "file" field; 415 for a non-multipart body', async () => {
    const t = await build();
    expect(
      (
        await upload(t.app, {
          field: 'photo',
          filename: 'a.jpg',
          contentType: 'image/jpeg',
          content: await makeImage(10, 10),
        })
      ).statusCode,
    ).toBe(400);
    const json = await t.app.inject({
      method: 'POST',
      url: '/upload',
      payload: { a: 1 },
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(json.statusCode).toBe(415);
  });

  it('429 after 30 uploads in 10 minutes', async () => {
    const t = await build();
    await t.redis.set('farmx:media:v1:rl:upload:u1', '30', 'EX', 600);
    const res = await upload(t.app, {
      filename: 'a.jpg',
      contentType: 'image/jpeg',
      content: await makeImage(10, 10),
    });
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('is documented in Swagger as multipart with the Media tag', async () => {
    const t = await build();
    const spec = (await t.app.inject({ method: 'GET', url: '/api-docs.json' })).json<{
      paths: Record<
        string,
        Record<
          string,
          {
            tags: string[];
            requestBody: unknown;
            security: unknown;
            responses: Record<string, unknown>;
          }
        >
      >;
    }>();
    const op = spec.paths['/upload']?.post;
    expect(op?.tags).toEqual(['Media']);
    expect(op?.requestBody).toEqual({ $ref: '#/components/requestBodies/FileUpload' });
    expect(op?.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(op?.responses ?? {})).toEqual(
      expect.arrayContaining(['201', '413', '415', '503']),
    );
  });
});
