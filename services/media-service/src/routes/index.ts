import type { DocsOptions, ServiceModule } from '@farmx/common/server';

import type { MediaConfig } from '../config/index.js';
import { MEDIA_TAG, mediaModule } from '../features/media/index.js';

/**
 * Every feature of media-service (no service prefix; the gateway maps `/v1/upload` → `/upload`
 * and `/v1/media/*` → `/*`). Health routes come from @farmx/common/server.
 *   POST /upload   media
 */
export const features: readonly ServiceModule[] = [mediaModule];

export const createDocsOptions = (config: MediaConfig): DocsOptions => ({
  title: 'FarmX Media API',
  version: config.SERVICE_VERSION,
  description: 'Image / video / PDF upload with compression to DigitalOcean Spaces.',
  tags: [
    { name: 'Health', description: 'Public liveness and readiness probes.' },
    { name: MEDIA_TAG, description: 'Upload media (logged-in users).' },
  ],
});
