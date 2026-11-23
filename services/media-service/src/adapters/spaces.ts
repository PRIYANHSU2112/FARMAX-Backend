import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { MediaConfig } from '../config/index.js';

export interface PutObjectInput {
  key: string;
  body: Buffer;
  contentType: string;
}

/** What the media feature needs from object storage (mockable in tests). */
export interface ObjectStorage {
  /** Uploads with `ACL: public-read` and long-lived immutable caching (keys are never reused). */
  putPublicObject(input: PutObjectInput): Promise<void>;
  publicUrl(key: string): string;
  /** Private object (no ACL grant): readable only through short-lived signed URLs. */
  putPrivateObject(input: PutObjectInput): Promise<void>;
  signedGetUrl(key: string, expiresInSeconds: number): Promise<string>;
  deleteObjects(keys: readonly string[]): Promise<void>;
}

type SpacesConfig = Pick<
  MediaConfig,
  | 'AWS_ENDPOINT'
  | 'AWS_REGION'
  | 'AWS_BUCKET_NAME'
  | 'AWS_ACCESS_KEY_ID'
  | 'AWS_SECRET_ACCESS_KEY'
  | 'MEDIA_PUBLIC_BASE_URL'
>;

/** Public URL: the CDN base when set, otherwise the bucket origin (virtual-hosted style). */
export function buildPublicUrl(config: SpacesConfig, key: string): string {
  const path = key.split('/').map(encodeURIComponent).join('/');
  if (config.MEDIA_PUBLIC_BASE_URL !== undefined) {
    return `${config.MEDIA_PUBLIC_BASE_URL.replace(/\/+$/, '')}/${path}`;
  }
  const endpoint = new URL(config.AWS_ENDPOINT);
  return `${endpoint.protocol}//${config.AWS_BUCKET_NAME}.${endpoint.host}/${path}`;
}

/** DigitalOcean Spaces through the S3 API. Credentials come from env and are never logged. */
export class SpacesStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly config: SpacesConfig;

  constructor(config: SpacesConfig, client?: S3Client) {
    this.config = config;
    this.client =
      client ??
      new S3Client({
        endpoint: config.AWS_ENDPOINT,
        region: config.AWS_REGION,
        forcePathStyle: false,
        credentials: {
          accessKeyId: config.AWS_ACCESS_KEY_ID,
          secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
        },
        maxAttempts: 3,
      });
  }

  async putPublicObject({ key, body, contentType }: PutObjectInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.AWS_BUCKET_NAME,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
        ACL: 'public-read',
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
  }

  publicUrl(key: string): string {
    return buildPublicUrl(this.config, key);
  }

  async putPrivateObject({ key, body, contentType }: PutObjectInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.AWS_BUCKET_NAME,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
        ACL: 'private',
        CacheControl: 'private, max-age=300',
      }),
    );
  }

  signedGetUrl(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.config.AWS_BUCKET_NAME, Key: key }),
      {
        expiresIn: expiresInSeconds,
      },
    );
  }

  async deleteObjects(keys: readonly string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.config.AWS_BUCKET_NAME,
          Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }

  destroy(): void {
    this.client.destroy();
  }
}
