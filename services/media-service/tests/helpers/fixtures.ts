import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import sharp from 'sharp';

export const ffmpegPath = createRequire(import.meta.url)('ffmpeg-static') as string;

/** Solid-colour test image in the given format. */
export const makeImage = (
  width: number,
  height: number,
  format: 'jpeg' | 'png' | 'webp' = 'jpeg',
) =>
  sharp({ create: { width, height, channels: 3, background: { r: 30, g: 140, b: 60 } } })
    .toFormat(format)
    .toBuffer();

/** Test MP4 (testsrc + sine audio) generated with the bundled ffmpeg. */
export async function makeVideo(width: number, height: number, seconds = 1): Promise<Buffer> {
  const out = join(tmpdir(), `farmx-test-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`);
  try {
    await promisify(execFile)(ffmpegPath, [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=${width}x${height}:rate=15:duration=${seconds}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${seconds}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      out,
    ]);
    return await readFile(out);
  } finally {
    await rm(out, { force: true });
  }
}

/** A minimal valid-looking PDF header + body. */
export const makePdf = () =>
  Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

/** multipart/form-data body with one file part (and optional extra fields). */
export function multipartBody(
  file: { field?: string; filename: string; contentType: string; content: Buffer },
  fields: Record<string, string> = {},
): { body: Buffer; contentType: string } {
  const boundary = `----farmx${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? 'file'}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`,
    ),
    file.content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
