import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  BadRequestError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  isAppError,
} from '@farmx/common/errors';
import { ok } from '@farmx/common/response';
import type { Cradle } from '@fastify/awilix';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { MAX_BYTES, type MediaKind, PARSER_MAX_BYTES } from './media.types.js';
import { typeForExtension } from './processing/detect.js';

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;
const isFileTooLarge = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'FST_REQ_FILE_TOO_LARGE';

/** Counts bytes and aborts the stream as soon as the per-kind limit is passed. */
const byteLimit = (limit: number, kind: MediaKind, onBytes: (n: number) => void) => {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      onBytes(total);
      if (total > limit)
        callback(new PayloadTooLargeError(`${kind} files must be at most ${megabytes(limit)}`));
      else callback(null, chunk);
    },
  });
};

/**
 * HTTP only: receives one multipart file, streams it to a private temp file (never into memory),
 * hands it to `mediaService.uploadMedia`, and always deletes the temp file.
 */
export class MediaController {
  private readonly mediaService: Cradle['mediaService'];

  constructor({ mediaService }: Pick<Cradle, 'mediaService'>) {
    this.mediaService = mediaService;
  }

  async upload(
    request: FastifyRequest<{ Querystring: { type?: MediaKind } }>,
    reply: FastifyReply,
  ) {
    if (!request.isMultipart()) {
      throw new UnsupportedMediaTypeError('Send multipart/form-data with one "file" field');
    }
    let part: MultipartFile | undefined;
    try {
      part = await request.file({
        limits: { fileSize: PARSER_MAX_BYTES, files: 1, fields: 5, parts: 6 },
      });
    } catch (error) {
      throw isAppError(error)
        ? error
        : new BadRequestError('Malformed multipart body', { cause: error });
    }
    if (part === undefined) throw new BadRequestError('No file: send one "file" field');

    const file = part;
    if (file.fieldname !== 'file') {
      file.file.resume();
      throw new BadRequestError('The file field must be named "file"');
    }
    let allowedKind: MediaKind;
    try {
      allowedKind = typeForExtension(file.filename).kind;
    } catch (error) {
      file.file.resume();
      throw error;
    }

    const tempPath = join(tmpdir(), `farmx-upload-${randomUUID()}`);
    let size = 0;
    try {
      await pipeline(
        file.file,
        byteLimit(MAX_BYTES[allowedKind], allowedKind, (n) => {
          size = n;
        }),
        createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }),
      );
      if (file.file.truncated) {
        throw new PayloadTooLargeError(
          `${allowedKind} files must be at most ${megabytes(MAX_BYTES[allowedKind])}`,
        );
      }
      if (size === 0) throw new BadRequestError('The file is empty');

      const uploaded = await this.mediaService.uploadMedia(
        { path: tempPath, filename: file.filename, mimetype: file.mimetype, size },
        request.query.type,
      );
      return await reply.code(201).send(ok(uploaded));
    } catch (error) {
      if (isFileTooLarge(error)) {
        throw new PayloadTooLargeError(
          `${allowedKind} files must be at most ${megabytes(MAX_BYTES[allowedKind])}`,
        );
      }
      throw error;
    } finally {
      await rm(tempPath, { force: true });
    }
  }
}
