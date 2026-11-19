import sharp from 'sharp';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { compressImage } from '../../src/features/media/processing/image.js';
import { VideoTranscoder, parseFfmpegLog } from '../../src/features/media/processing/video.js';
import { sniffMime } from '../../src/features/media/processing/detect.js';
import { ffmpegPath, makeImage, makeVideo } from '../helpers/fixtures.js';

let dir = '';
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'farmx-media-test-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('image compression (sharp)', () => {
  it('fits inside 1920×1080 and outputs WebP', async () => {
    const out = await compressImage(await makeImage(4000, 3000, 'jpeg'));
    expect(out).toMatchObject({
      contentType: 'image/webp',
      extension: 'webp',
      width: 1440,
      height: 1080,
    });
    expect(sniffMime(out.body)).toBe('image/webp');
  });

  it('never enlarges small images', async () => {
    const out = await compressImage(await makeImage(640, 480, 'png'));
    expect(out).toMatchObject({ width: 640, height: 480 });
  });

  it('auto-orients from EXIF and strips all metadata (EXIF/GPS)', async () => {
    const rotated = await sharp(await makeImage(300, 100, 'jpeg'))
      .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: 'secret-gps-owner' } } })
      .jpeg()
      .toBuffer();
    const out = await compressImage(rotated);
    expect(out).toMatchObject({ width: 100, height: 300 });
    const meta = await sharp(out.body).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it('refuses corrupt input (415)', async () => {
    await expect(compressImage(Buffer.from('not an image'))).rejects.toMatchObject({
      statusCode: 415,
    });
  });
});

describe('video compression (ffmpeg)', () => {
  it('transcodes to H.264/AAC MP4, max 1080p, smaller than a 1440p source', async () => {
    const input = join(dir, 'in.mp4');
    await writeFile(input, await makeVideo(2560, 1440, 1));
    const out = await new VideoTranscoder({ ffmpegPath, maxConcurrent: 1 }).transcode(input);
    expect(out).toMatchObject({
      contentType: 'video/mp4',
      extension: 'mp4',
      width: 1920,
      height: 1080,
    });
    expect(out.durationSeconds).toBeGreaterThan(0.5);
    expect(sniffMime(out.body)).toBe('video/mp4');
  }, 60_000);

  it('keeps 720p sources at 720p', async () => {
    const input = join(dir, 'in720.mp4');
    await writeFile(input, await makeVideo(1280, 720, 1));
    const out = await new VideoTranscoder({ ffmpegPath, maxConcurrent: 1 }).transcode(input);
    expect(out).toMatchObject({ width: 1280, height: 720 });
  }, 60_000);

  it('rejects a corrupt video (400) and limits concurrency (503)', async () => {
    const bad = join(dir, 'bad.mp4');
    await writeFile(
      bad,
      Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(64)]),
    );
    const transcoder = new VideoTranscoder({ ffmpegPath, maxConcurrent: 1 });
    await expect(transcoder.transcode(bad)).rejects.toMatchObject({ statusCode: 400 });

    const slow = new VideoTranscoder({ ffmpegPath, maxConcurrent: 1 });
    const first = slow.transcode(bad).catch(() => undefined);
    await expect(slow.transcode(bad)).rejects.toMatchObject({ statusCode: 503 });
    await first;
  }, 60_000);

  it('parses duration and output size from the ffmpeg log', () => {
    const log =
      'Duration: 00:01:02.50, start: 0\nOutput #0, mp4\n  Stream #0:0: Video: h264 (High), yuv420p(progressive), 1280x720, q=2-31';
    expect(parseFfmpegLog(log)).toEqual({ durationSeconds: 62.5, width: 1280, height: 720 });
  });
});
