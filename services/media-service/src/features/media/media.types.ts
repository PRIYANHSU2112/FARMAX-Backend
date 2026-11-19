export const MEDIA_KINDS = ['image', 'video', 'document'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Per-kind upload limits (bytes, before compression). */
export const MAX_BYTES: Readonly<Record<MediaKind, number>> = {
  image: 5 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  document: 10 * 1024 * 1024,
};

/** Largest accepted part at the multipart parser (the biggest per-kind limit). */
export const PARSER_MAX_BYTES = Math.max(...Object.values(MAX_BYTES));

/** Strict allowlist: extension, declared MIME type and detected signature must all agree. */
export interface AllowedType {
  kind: MediaKind;
  mime: string;
  extensions: readonly string[];
}

export const ALLOWED_TYPES: readonly AllowedType[] = [
  { kind: 'image', mime: 'image/jpeg', extensions: ['.jpg', '.jpeg'] },
  { kind: 'image', mime: 'image/png', extensions: ['.png'] },
  { kind: 'image', mime: 'image/webp', extensions: ['.webp'] },
  { kind: 'video', mime: 'video/mp4', extensions: ['.mp4'] },
  { kind: 'document', mime: 'application/pdf', extensions: ['.pdf'] },
];

/** A received file, already on local disk (multipart streamed to a temp file). */
export interface IncomingFile {
  path: string;
  filename: string;
  /** MIME type declared by the client (never trusted alone). */
  mimetype: string;
  size: number;
}

export interface UploadedMedia {
  url: string;
  key: string;
  kind: MediaKind;
  contentType: string;
  /** Stored size (after compression). */
  size: number;
  originalSize: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

/** Output of a processor, ready to upload. */
export interface ProcessedMedia {
  body: Buffer;
  contentType: string;
  extension: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
}
