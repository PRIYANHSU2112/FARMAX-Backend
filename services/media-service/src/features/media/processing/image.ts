import { UnsupportedMediaTypeError } from '@farmx/common/errors';
import sharp from 'sharp';

import type { ProcessedMedia } from '../media.types.js';

export const IMAGE_MAX_WIDTH = 1920;
export const IMAGE_MAX_HEIGHT = 1080;
export const WEBP_QUALITY = 80;
/** Decompression-bomb guard: refuse images above 40 megapixels before decoding them fully. */
const MAX_INPUT_PIXELS = 40_000_000;

/**
 * Auto-orient (EXIF), fit inside 1920×1080 without enlarging, encode WebP q80.
 * sharp drops all metadata by default, so EXIF/GPS never reaches the bucket.
 */
export async function compressImage(input: string | Buffer): Promise<ProcessedMedia> {
  try {
    const { data, info } = await sharp(input, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: 'error',
    })
      .rotate()
      .resize({
        width: IMAGE_MAX_WIDTH,
        height: IMAGE_MAX_HEIGHT,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return {
      body: data,
      contentType: 'image/webp',
      extension: 'webp',
      width: info.width,
      height: info.height,
    };
  } catch (error) {
    throw new UnsupportedMediaTypeError(
      'Image is corrupt, unsupported or larger than 40 megapixels',
      { cause: error },
    );
  }
}
