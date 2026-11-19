import { createRequire } from 'node:module';

import { loadJwtPublicKey, parseAccessClaims, toAuthUser, verifyJwt } from '@farmx/common/auth';
import { ServiceUnavailableError } from '@farmx/common/errors';
import type { Logger } from '@farmx/common/logger';
import type { TokenVerifier } from '@farmx/common/middleware';
import { type Redis, authKeys, createCacheClient } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';
import { type AwilixContainer, asFunction, asValue, createContainer } from 'awilix';

import { type ObjectStorage, SpacesStorage } from './adapters/spaces.js';
import type { MediaConfig } from './config/index.js';
import { VideoTranscoder } from './features/media/index.js';

declare module '@fastify/awilix' {
  interface Cradle {
    config: Readonly<MediaConfig>;
    logger: Logger;
    /** redis-cache: token revocation flags (written by auth-service) and upload rate limits. */
    redis: Redis;
    storage: ObjectStorage;
    videoTranscoder: VideoTranscoder;
    tokenVerifier: TokenVerifier;
  }
}

export interface ContainerDeps {
  config: Readonly<MediaConfig>;
  logger: Logger;
}

/** ffmpeg-static is CommonJS (`module.exports = path`); its binary path, or null if unsupported. */
const bundledFfmpeg = createRequire(import.meta.url)('ffmpeg-static') as string | null;

/**
 * Verifies auth-service access tokens with its PUBLIC key (this service cannot issue tokens),
 * then checks the logout / session revocation flags in one Redis round trip.
 */
function buildTokenVerifier(
  config: MediaConfig,
  logger: Logger,
  redis: () => Redis,
): TokenVerifier {
  if (config.JWT_PUBLIC_KEY === undefined) {
    logger.warn(
      'JWT_PUBLIC_KEY not set: every upload is refused (401). Copy it from auth-service.',
    );
    return () => Promise.reject(new Error('JWT_PUBLIC_KEY not configured'));
  }
  const key = loadJwtPublicKey(config.JWT_KEY_ID, config.JWT_PUBLIC_KEY);
  const options = { issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE };
  return async (token) => {
    const claims = parseAccessClaims(verifyJwt(token, key, options));
    let flags: (string | null)[];
    try {
      flags = await redis().mget(authKeys.revokedJti(claims.jti), authKeys.revokedSid(claims.sid));
    } catch (error) {
      throw new ServiceUnavailableError('Session store unavailable', { cause: error });
    }
    if (flags.some((flag) => flag !== null)) throw new Error('token revoked');
    return toAuthUser(claims);
  };
}

export function createAppContainer({ config, logger }: ContainerDeps): AwilixContainer<Cradle> {
  const container = createContainer<Cradle>({ strict: true });
  const ffmpegPath = config.FFMPEG_PATH ?? bundledFfmpeg;
  if (ffmpegPath === null) throw new Error('No ffmpeg binary for this platform; set FFMPEG_PATH');

  container.register({
    config: asValue(config),
    logger: asValue(logger),
    redis: asFunction(({ config: cfg, logger: log }: Cradle) =>
      createCacheClient(cfg.REDIS_CACHE_URL, { logger: log, name: 'media-service-cache' }),
    )
      .singleton()
      .disposer(async (client) => {
        await client.quit();
      }),
    storage: asFunction(({ config: cfg }: Cradle) => new SpacesStorage(cfg))
      .singleton()
      .disposer((storage) => {
        if (storage instanceof SpacesStorage) storage.destroy();
      }),
    videoTranscoder: asValue(
      new VideoTranscoder({ ffmpegPath, maxConcurrent: config.MEDIA_MAX_CONCURRENT_TRANSCODES }),
    ),
    tokenVerifier: asFunction((cradle: Cradle) =>
      buildTokenVerifier(cradle.config, cradle.logger, () => cradle.redis),
    ).singleton(),
  });

  return container;
}
