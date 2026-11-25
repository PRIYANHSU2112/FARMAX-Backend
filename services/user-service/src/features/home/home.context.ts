import { userKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';
import type { FastifyRequest } from 'fastify';

import { authStateOf, bearerOf } from '../../middleware/guards.js';
import { langOf } from './home.rules.js';
import {
  type FarmFacts,
  type HomeContext,
  PLATFORMS,
  type Platform,
  type PreviewQuery,
} from './home.types.js';

const FARM_TTL_SECONDS = 600;
/** "No active farm" / lookup failed recently: don't ask farm-service on every request. */
const NO_FARM_TTL_SECONDS = 60;
const FARM_TIMEOUT_MS = 300;
const NONE = 'null';

const DEVICE_ID = /^[A-Za-z0-9._-]{8,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^\d{1,4}(\.\d{1,4}){0,2}$/;

const header = (request: FastifyRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const platformOf = (value: string | undefined): Platform | null => {
  const v = value?.trim().toLowerCase();
  return PLATFORMS.find((p) => p === v) ?? null;
};

/** `X-SDUI-Version` → 1..99; missing or junk → 1 (the oldest widget set). */
export const sduiOf = (value: string | undefined): number => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 99 ? n : 1;
};

/**
 * Builds the per-request context. Region and depot come ONLY from the farmer's own farm
 * (farm-service, cached 10 min per user + farm); `X-Region` / `nodeId` from the app are never
 * read. Guests have no region (⏳ Future: needs a public pincode lookup).
 */
export class HomeContextService {
  constructor(private readonly deps: Pick<Cradle, 'farmClient' | 'redis' | 'logger'>) {}

  async build(request: FastifyRequest): Promise<HomeContext> {
    const user = request.user;
    const farmer = user !== null && user.userType === 'CUSTOMER';
    const bearer = farmer ? (bearerOf(request) ?? null) : null;
    const deviceId = header(request, 'x-device-id');
    const farmId = header(request, 'x-farm-id');
    const appVersion = header(request, 'x-app-version');

    const farm =
      farmer && bearer !== null
        ? await this.farm(
            user.id,
            bearer,
            farmId !== undefined && UUID.test(farmId) ? farmId : undefined,
          )
        : null;

    return {
      platform: platformOf(header(request, 'x-platform')),
      appVersion: appVersion !== undefined && VERSION.test(appVersion) ? appVersion : null,
      sdui: sduiOf(header(request, 'x-sdui-version')),
      lang: langOf(header(request, 'accept-language')),
      userType: farmer ? 'farmer' : 'guest',
      userId: farmer ? user.id : null,
      deviceId: deviceId !== undefined && DEVICE_ID.test(deviceId) ? deviceId : null,
      authState: authStateOf(request),
      region: farm?.territoryCode ?? null,
      nodeId: farm?.primaryNodeId ?? null,
      farmTypes: farm?.productionTypes ?? [],
      farm,
      bearer,
      now: Date.now(),
    };
  }

  private async farm(
    userId: string,
    bearer: string,
    farmId: string | undefined,
  ): Promise<FarmFacts | null> {
    const key = userKeys.homeContext(userId, farmId ?? 'default');
    const redis = this.deps.redis;
    try {
      const cached = await redis.get(key);
      if (cached !== null) return cached === NONE ? null : (JSON.parse(cached) as FarmFacts);
    } catch (err) {
      this.deps.logger.warn({ err }, 'home context cache unavailable');
    }

    let farm: FarmFacts | null = null;
    try {
      farm = await this.deps.farmClient.context(bearer, farmId, FARM_TIMEOUT_MS);
    } catch (err) {
      this.deps.logger.warn({ err }, 'home: farm context unavailable; serving without region');
    }
    await redis
      .set(
        key,
        farm === null ? NONE : JSON.stringify(farm),
        'EX',
        farm === null ? NO_FARM_TTL_SECONDS : FARM_TTL_SECONDS,
      )
      .catch(() => undefined);
    return farm;
  }
}

/** Admin preview: the caller is whoever the query describes (no token, no farm lookup). */
export const previewContext = (q: PreviewQuery): HomeContext => ({
  platform: q.platform ?? null,
  appVersion: q.appVersion ?? null,
  sdui: q.sdui ?? 99,
  lang: q.lang ?? 'en',
  userType: q.userType ?? 'guest',
  userId: null,
  deviceId: q.deviceId ?? null,
  authState: 'none',
  region: q.region ?? null,
  nodeId: null,
  farmTypes: q.farmType ?? [],
  farm: null,
  bearer: null,
  now: q.at?.getTime() ?? Date.now(),
});
