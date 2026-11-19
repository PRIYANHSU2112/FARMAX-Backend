import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

export const MEDIA_TAG = 'Media';

const uploadedSchema = Joi.object({
  url: Joi.string().uri().description('Public URL (CDN when MEDIA_PUBLIC_BASE_URL is set)'),
  key: Joi.string().example('dev/0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e01.webp'),
  kind: Joi.string().valid('image', 'video', 'document'),
  contentType: Joi.string().example('image/webp'),
  size: Joi.number().integer().description('Stored bytes (after compression)'),
  originalSize: Joi.number().integer().description('Uploaded bytes'),
  width: Joi.number().integer(),
  height: Joi.number().integer(),
  durationSeconds: Joi.number().description('Videos only'),
}).meta({ className: 'MediaUpload' });

export const MEDIA_DOCS = {
  upload: {
    tag: MEDIA_TAG,
    summary: 'Upload an image, video or PDF',
    description: [
      'multipart/form-data with one `file` field. Extension, declared type and file signature must all match.',
      '',
      '| Kind | Types | Max | Stored as |',
      '|---|---|---|---|',
      '| image | JPEG, PNG, WebP | 5 MB | WebP q80, max 1920×1080, auto-oriented, metadata removed |',
      '| video | MP4 | 50 MB | H.264 + AAC MP4, max 1080p, faststart |',
      '| document | PDF | 10 MB | unchanged |',
      '',
      'Stored at `<folder>/<uuidv7>.<ext>` with **public-read** access. Limit: 30 uploads / 10 min per user.',
    ].join('\n'),
    fileUpload: true,
    success: {
      status: 201,
      description: 'Uploaded',
      data: uploadedSchema,
      example: {
        success: true,
        data: {
          url: 'https://farmx.blr1.digitaloceanspaces.com/dev/0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e01.webp',
          key: 'dev/0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e01.webp',
          kind: 'image',
          contentType: 'image/webp',
          size: 182_344,
          originalSize: 3_912_004,
          width: 1920,
          height: 1080,
        },
      },
    },
    errors: [400, 413, 415, 422, 503],
  },
} satisfies Record<string, RouteDocs>;
