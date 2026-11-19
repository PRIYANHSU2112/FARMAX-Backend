import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BadRequestError, ServiceUnavailableError } from '@farmx/common/errors';

import type { ProcessedMedia } from '../media.types.js';

export const VIDEO_MAX_WIDTH = 1920;
export const VIDEO_MAX_HEIGHT = 1080;
const STDERR_TAIL = 4_000;

export interface VideoTranscoderOptions {
  ffmpegPath: string;
  /** Concurrent transcodes per process; more → 503 (CPU protection). */
  maxConcurrent: number;
  timeoutMs?: number;
}

/**
 * Fixed argument list (no shell, nothing user-controlled except the temp input path):
 * H.264 High / yuv420p, CRF 28, max 1080p keeping aspect ratio (720p stays 720p), even
 * dimensions, AAC 128k stereo, faststart for streaming, all metadata stripped.
 */
export const transcodeArgs = (input: string, output: string): string[] => [
  '-hide_banner',
  '-nostdin',
  '-y',
  '-i',
  input,
  '-map',
  '0:v:0',
  '-map',
  '0:a:0?',
  '-vf',
  `scale='min(${VIDEO_MAX_WIDTH},iw)':'min(${VIDEO_MAX_HEIGHT},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-crf',
  '28',
  '-profile:v',
  'high',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  '-b:a',
  '128k',
  '-ac',
  '2',
  '-movflags',
  '+faststart',
  '-map_metadata',
  '-1',
  output,
];

/** Duration from the input header, dimensions from the output stream line of ffmpeg's log. */
export function parseFfmpegLog(stderr: string): {
  durationSeconds?: number;
  width?: number;
  height?: number;
} {
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const outputSection = stderr.slice(stderr.indexOf('Output #0'));
  const size = /Video: h264[^\n]*?, (\d{2,5})x(\d{2,5})/.exec(outputSection);
  return {
    ...(duration === null
      ? {}
      : {
          durationSeconds:
            Math.round(
              (Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 100,
            ) / 100,
        }),
    ...(size === null ? {} : { width: Number(size[1]), height: Number(size[2]) }),
  };
}

export class VideoTranscoder {
  private active = 0;
  private readonly timeoutMs: number;

  constructor(private readonly options: VideoTranscoderOptions) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async transcode(inputPath: string): Promise<ProcessedMedia> {
    if (this.active >= this.options.maxConcurrent) {
      throw new ServiceUnavailableError('Video processing is busy, retry shortly');
    }
    this.active += 1;
    const outputPath = join(tmpdir(), `farmx-video-${randomUUID()}.mp4`);
    try {
      const stderr = await this.run(transcodeArgs(inputPath, outputPath));
      const body = await readFile(outputPath);
      return { body, contentType: 'video/mp4', extension: 'mp4', ...parseFfmpegLog(stderr) };
    } finally {
      this.active -= 1;
      await rm(outputPath, { force: true });
    }
  }

  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.ffmpegPath, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-64_000);
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new BadRequestError('Video took too long to process (too long or too complex)'));
      }, this.timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new ServiceUnavailableError('Video processor unavailable', { cause: error }));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stderr);
        else {
          // The ffmpeg log stays server-side (it contains temp paths); the client gets a plain reason.
          reject(
            new BadRequestError('Video is corrupt or uses an unsupported codec', {
              cause: new Error(stderr.slice(-STDERR_TAIL)),
            }),
          );
        }
      });
    });
  }
}
