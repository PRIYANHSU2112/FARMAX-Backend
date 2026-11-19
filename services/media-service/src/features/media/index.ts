// Public API of the media feature. Other features import ONLY from here.
export { mediaModule } from './media.module.js';
export type { MediaService } from './media.service.js';
export type { IncomingFile, MediaKind, UploadedMedia } from './media.types.js';
export { MEDIA_TAG } from './media.docs.js';
export { VideoTranscoder } from './processing/video.js';
