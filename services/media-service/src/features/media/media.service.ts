import { readFile } from 'node:fs/promises';

import { ExternalServiceError, PayloadTooLargeError, ValidationError } from '@farmx/common/errors';
import type { Cradle } from '@fastify/awilix';

import {
  type IncomingFile,
  MAX_BYTES,
  type MediaKind,
  type ProcessedMedia,
  type UploadedMedia,
} from './media.types.js';
import { readHead, resolveAllowedType } from './processing/detect.js';
import { compressImage } from './processing/image.js';
import { uuidv7 } from './processing/uuidv7.js';

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * Public API of the media feature. `uploadMedia(file, type)`:
 * validate (extension + MIME + magic bytes) → per-kind size limit → compress → upload to
 * Spaces as `<folder>/<uuidv7>.<ext>` (public-read) → public URL.
 */
export class MediaService {
  private readonly deps: Pick<Cradle, 'storage' | 'videoTranscoder' | 'config' | 'logger'>;

  constructor(deps: Pick<Cradle, 'storage' | 'videoTranscoder' | 'config' | 'logger'>) {
    this.deps = deps;
  }

  /** `type` (optional) must match the detected kind; otherwise 422. */
  async uploadMedia(file: IncomingFile, type?: MediaKind): Promise<UploadedMedia> {
    const allowed = resolveAllowedType({ ...file, head: await readHead(file.path) });
    if (type !== undefined && type !== allowed.kind) {
      throw new ValidationError([
        { path: 'querystring.type', message: `The file is a ${allowed.kind}, not a ${type}` },
      ]);
    }
    if (file.size > MAX_BYTES[allowed.kind]) {
      throw new PayloadTooLargeError(
        `${allowed.kind} files must be at most ${megabytes(MAX_BYTES[allowed.kind])}`,
      );
    }

    const processed = await this.process(allowed.kind, file.path);
    const key = `${this.deps.config.BUCKET_FOLDER_PATH}/${uuidv7()}.${processed.extension}`;
    try {
      await this.deps.storage.putPublicObject({
        key,
        body: processed.body,
        contentType: processed.contentType,
      });
    } catch (error) {
      throw new ExternalServiceError('spaces', { cause: error });
    }
    this.deps.logger.info(
      { key, kind: allowed.kind, originalSize: file.size, size: processed.body.length },
      'media uploaded',
    );

    return {
      url: this.deps.storage.publicUrl(key),
      key,
      kind: allowed.kind,
      contentType: processed.contentType,
      size: processed.body.length,
      originalSize: file.size,
      ...(processed.width === undefined ? {} : { width: processed.width }),
      ...(processed.height === undefined ? {} : { height: processed.height }),
      ...(processed.durationSeconds === undefined
        ? {}
        : { durationSeconds: processed.durationSeconds }),
    };
  }

  private async process(kind: MediaKind, path: string): Promise<ProcessedMedia> {
    if (kind === 'image') return compressImage(path);
    if (kind === 'video') return this.deps.videoTranscoder.transcode(path);
    return { body: await readFile(path), contentType: 'application/pdf', extension: 'pdf' };
  }
}
